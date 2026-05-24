import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { Rep } from '../reps/entities/rep.entity';
import { Region } from '../regions/entities/region.entity';
import { Warehouse } from '../warehouses/entities/warehouse.entity';
import { AppSettings } from '../settings/entities/app-settings.entity';
import { ItemCart } from '../items/entities/item-cart.entity';
import { ItemSwitch } from '../items/entities/item-switch.entity';
import { ItemBalanceView } from '../items/entities/item-balance.view';
import { ProductCategory } from '../products/entities/product-category.entity';
import { filsToJod } from '../../common/utils/currency.util';
import {
  CompanyMetaDto,
  ItemBalanceRowDto,
  ItemDto,
  ItemUnitDto,
  SalesmanDto,
} from './dto/mobile.dto';

@Injectable()
export class MobileService {
  constructor(
    @InjectRepository(Region) private readonly regions: Repository<Region>,
    @InjectRepository(Warehouse) private readonly warehouses: Repository<Warehouse>,
    @InjectRepository(AppSettings) private readonly settings: Repository<AppSettings>,
    @InjectRepository(ItemCart) private readonly items: Repository<ItemCart>,
    @InjectRepository(ItemSwitch) private readonly switches: Repository<ItemSwitch>,
    @InjectRepository(ItemBalanceView)
    private readonly balances: Repository<ItemBalanceView>,
    @InjectRepository(ProductCategory)
    private readonly categories: Repository<ProductCategory>,
  ) {}

  async getSalesman(rep: Rep, companyNumber: string): Promise<SalesmanDto> {
    const region = rep.regionId
      ? await this.regions.findOne({ where: { id: rep.regionId } })
      : null;
    const warehouse = rep.vanId
      ? await this.warehouses.findOne({ where: { id: rep.vanId } })
      : null;
    return {
      companyNumber,
      salesmanCode: rep.code ?? '',
      salesmanNameAr: rep.nameAr,
      salesmanNameEn: rep.nameEn ?? null,
      salesmanPhone: rep.phone ?? null,
      routeCode: region?.code ?? null,
      routeNameAr: region?.nameAr ?? null,
      routeNameEn: region?.nameEn ?? null,
      storeNumber: warehouse?.whNumber ?? null,
      pricePhase: '1', // single-price build: no tiered phases
      isActive: rep.isActive,
    };
  }

  async getCompanyMeta(
    companyNumber: string,
    salesmanCode: string,
  ): Promise<CompanyMetaDto> {
    const row = await this.settings.findOne({ where: { id: 1 } });
    if (!row) throw new NotFoundException('app_settings row missing — re-run migrations');
    return {
      companyNumber,
      salesmanCode,
      companyName: row.companyNameEn || row.companyNameAr,
      taxNumber: row.sellerTin ?? null,
      companyPhone: row.sellerPhone ?? null,
      logo: row.logoUrl ?? '',
    };
  }

  async getItem(
    itemCode: string,
    rep: Rep,
    companyNumber: string,
    salesmanCode: string,
  ): Promise<ItemDto> {
    const item = await this.items.findOne({
      where: { itemNumber: itemCode, deletedAt: IsNull() },
    });
    if (!item) {
      throw new NotFoundException(`Item ${itemCode} not found for company ${companyNumber}`);
    }

    const category = item.categoryId
      ? await this.categories.findOne({ where: { id: item.categoryId } })
      : null;

    // Base stock for this item in the salesman's van store (for per-unit qty).
    const vanStore = rep.vanId
      ? (await this.warehouses.findOne({ where: { id: rep.vanId } }))?.whNumber ?? null
      : null;
    let baseVanQty = 0;
    if (vanStore) {
      const bal = await this.balances.findOne({
        where: { itemNumber: itemCode, stockNumber: vanStore },
      });
      baseVanQty = bal ? Math.trunc(Number(bal.qty)) : 0;
    }

    const switchRows = await this.switches.find({
      where: { itemNumber: itemCode, deletedAt: IsNull() },
      order: { unitQty: 'ASC' },
    });
    const itemUnits: ItemUnitDto[] = switchRows.map((sw) => {
      const factor = sw.unitQty > 0 ? sw.unitQty : 1;
      return {
        unitName: sw.unitName,
        unitCode: sw.barcode,
        unitPrice: toPrice3(sw.salePrice),
        unitQty: String(Math.floor(baseVanQty / factor)),
      };
    });

    const itemPrice = filsToJod(item.price); // already 3-decimal string
    return {
      companyNumber,
      salesmanCode,
      itemCode: item.itemNumber,
      itemNameAr: item.nameAr,
      itemNameEn: item.nameEn ?? null,
      itemPrice,
      itemBarcode: item.barcode,
      itemPic: item.imageUrl ?? item.photoUrl ?? '',
      itemCategory: category?.nameEn ?? category?.nameAr ?? null,
      taxPerc: taxPercToString(item.taxRate),
      itemUnits,
      itemPriceList: [{ phaseNumber: '1', phasePrice: itemPrice }],
    };
  }

  async getItemBalance(
    itemNumber: string,
    storeNo: string | undefined,
    companyNumber: string,
    salesmanCode: string,
  ): Promise<ItemBalanceRowDto[]> {
    const qb = this.balances
      .createQueryBuilder('b')
      .where('b.item_number = :itemNumber', { itemNumber })
      .andWhere('b.stock_number IS NOT NULL');
    if (storeNo) qb.andWhere('b.stock_number = :storeNo', { storeNo });
    const rows = await qb.orderBy('b.stock_number', 'ASC').getMany();

    return rows.map((r) => ({
      companyNumber,
      salesmanCode,
      itemNumber: r.itemNumber,
      itemQty: String(Math.trunc(Number(r.qty))),
      storeNumber: r.stockNumber as string,
    }));
  }
}

/** numeric/string JOD → 3-decimal string, e.g. 4.2 → "4.200". */
function toPrice3(value: string | number): string {
  return Number(value).toFixed(3);
}

/** tax_rate "0.1600" → "16". */
function taxPercToString(rate: string | number): string {
  return String(Math.round(Number(rate) * 100));
}
