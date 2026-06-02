import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import { Rep } from '../reps/entities/rep.entity';
import { Region } from '../regions/entities/region.entity';
import { Warehouse } from '../warehouses/entities/warehouse.entity';
import { AppSettings } from '../settings/entities/app-settings.entity';
import { ItemCart } from '../items/entities/item-cart.entity';
import { ItemUnit } from '../units/entities/item-unit.entity';
import { ItemBalanceView } from '../items/entities/item-balance.view';
import { ProductCategory } from '../products/entities/product-category.entity';
import { VanStock } from '../products/entities/van-stock.entity';
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
    @InjectRepository(ItemUnit) private readonly itemUnitsRepo: Repository<ItemUnit>,
    @InjectRepository(ItemBalanceView)
    private readonly balances: Repository<ItemBalanceView>,
    @InjectRepository(ProductCategory)
    private readonly categories: Repository<ProductCategory>,
    @InjectRepository(VanStock) private readonly vanStock: Repository<VanStock>,
  ) {}

  async getSalesman(
    rep: Rep,
    companyNumber: string,
    salesmanCode: string,
  ): Promise<SalesmanDto> {
    const region = rep.regionId
      ? await this.regions.findOne({ where: { id: rep.regionId } })
      : null;
    const warehouse = rep.vanId
      ? await this.warehouses.findOne({ where: { id: rep.vanId } })
      : null;
    return {
      companyNumber,
      salesmanCode, // = user.userNumber (e.g. "U-0001")
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

    // Base stock for this item on the salesman's van comes from van_stock (the
    // VanFlow per-rep load), not the legacy posted-voucher item_balance view.
    const v = await this.vanStock.findOne({
      where: { repId: rep.id, productId: item.id },
    });
    const baseVanQty = v?.quantity ?? 0;

    // Per-item unit mappings come from item_units; the conversion factor lives
    // on the unit master (`unit.baseQty`). PCE = base = 1.
    const itemUnitRows = await this.itemUnitsRepo.find({
      where: { itemId: item.id },
      relations: { unit: true },
      order: { unit: { baseQty: 'ASC' } },
    });
    const itemUnits: ItemUnitDto[] = itemUnitRows.map((iu) => {
      const factor =
        iu.unit?.baseQty && iu.unit.baseQty > 0 ? iu.unit.baseQty : 1;
      return {
        unitName: iu.unit?.nameAr ?? iu.unit?.nameEn ?? '',
        unitCode: iu.barcode,
        unitPrice: toPrice3(iu.salePrice),
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

  /**
   * The salesman's van as the frontend wants it: each loaded item returned with
   * the full catalog row + on-van quantity + the item's allowed unit mappings.
   */
  async getVanStock(
    rep: Rep,
  ): Promise<Array<Record<string, unknown>>> {
    const vsRows = await this.vanStock.find({ where: { repId: rep.id } });
    if (vsRows.length === 0) return [];
    const itemIds = vsRows.map((v) => v.productId);

    const items = await this.items.find({ where: { id: In(itemIds) } });
    const itemById = new Map(items.map((i) => [i.id, i]));

    const ius = await this.itemUnitsRepo.find({
      where: { itemId: In(itemIds) },
      relations: { unit: true },
      order: { unit: { baseQty: 'ASC' } },
    });
    const unitsByItem = new Map<string, Array<Record<string, unknown>>>();
    for (const iu of ius) {
      const arr = unitsByItem.get(iu.itemId) ?? [];
      arr.push({
        unitId: iu.unitId,
        unitCode: iu.unit?.code ?? '',
        unitName: iu.unit?.nameAr ?? '',
        unitNameEn: iu.unit?.nameEn ?? null,
        qty: iu.unit?.baseQty ?? 1,
        isBase: iu.unit?.code === 'PCE',
        barcode: iu.barcode,
        salePrice: Number(iu.salePrice).toFixed(3),
      });
      unitsByItem.set(iu.itemId, arr);
    }

    const out: Array<Record<string, unknown>> = [];
    for (const v of vsRows) {
      const item = itemById.get(v.productId);
      if (!item) continue;
      out.push({
        ...item,
        quantity: v.quantity,
        units: unitsByItem.get(item.id) ?? [],
      });
    }
    return out;
  }

  async getItemBalance(
    itemNumber: string,
    storeNo: string | undefined,
    rep: Rep,
    companyNumber: string,
    salesmanCode: string,
  ): Promise<ItemBalanceRowDto[]> {
    // Resolve the rep's van store number (e.g. "4") and the catalog row (we
    // need its UUID id to look up van_stock).
    const vanStoreNumber = rep.vanId
      ? (await this.warehouses.findOne({ where: { id: rep.vanId } }))?.whNumber ?? null
      : null;
    const item = await this.items.findOne({
      where: { itemNumber, deletedAt: IsNull() },
    });

    const wantVan = !!vanStoreNumber && (!storeNo || storeNo === vanStoreNumber);
    const wantOther = !storeNo || storeNo !== vanStoreNumber;
    const out: ItemBalanceRowDto[] = [];

    // 1. Non-van stores from the legacy item_balance view (posted vouchers).
    if (wantOther) {
      const qb = this.balances
        .createQueryBuilder('b')
        .where('b.item_number = :itemNumber', { itemNumber })
        .andWhere('b.stock_number IS NOT NULL');
      if (storeNo) {
        qb.andWhere('b.stock_number = :s', { s: storeNo });
      } else if (vanStoreNumber) {
        // No filter: exclude the van so van_stock is the single source for it.
        qb.andWhere('b.stock_number <> :van', { van: vanStoreNumber });
      }
      const rows = await qb.orderBy('b.stock_number', 'ASC').getMany();
      for (const r of rows) {
        out.push({
          companyNumber,
          salesmanCode,
          itemNumber: r.itemNumber,
          itemQty: String(Math.trunc(Number(r.qty))),
          storeNumber: r.stockNumber as string,
        });
      }
    }

    // 2. Van store from van_stock (per-rep load).
    if (wantVan && item) {
      const v = await this.vanStock.findOne({
        where: { repId: rep.id, productId: item.id },
      });
      const qty = v?.quantity ?? 0;
      // Include the van row when explicitly asked, or whenever it has stock.
      if (storeNo === vanStoreNumber || qty > 0) {
        out.push({
          companyNumber,
          salesmanCode,
          itemNumber,
          itemQty: String(qty),
          storeNumber: vanStoreNumber as string,
        });
      }
    }

    out.sort((a, b) => a.storeNumber.localeCompare(b.storeNumber));
    return out;
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
