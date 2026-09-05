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
import { ErpSyncService } from '../erp-sync/erp-sync.service';
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
    private readonly erpSync: ErpSyncService,
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

    // Base stock for this item on the salesman's van — read from the posted-voucher
    // `item_balance` ledger for the rep's van store, the single source of truth shared
    // with the dashboard and the SALE stock check.
    const vanStoreNumber = rep.vanId
      ? (await this.warehouses.findOne({ where: { id: rep.vanId } }))?.whNumber ?? null
      : null;
    // One row per pool now, so read them all and index by pool: '' is the
    // item's base pieces, anything else a variant that owns its stock.
    const balRows = vanStoreNumber
      ? await this.balances.find({
          where: { itemNumber: item.itemNumber, stockNumber: vanStoreNumber },
        })
      : [];
    const poolQty = new Map(
      balRows.map((b) => [b.stockUnitCode ?? '', Math.trunc(Number(b.qty))]),
    );
    const baseVanQty = poolQty.get('') ?? 0;

    // Per-item unit mappings come from item_units, and so does the conversion
    // factor (`item_units.qty` — `units.base_qty` is only a default for new
    // attachments). A variant unit reports its OWN pool; a packaging unit still
    // reports how many of it the shared base pool can make.
    const itemUnitRows = await this.itemUnitsRepo.find({
      where: { itemId: item.id },
      relations: { unit: true },
      order: { unit: { baseQty: 'ASC' } },
    });
    const itemUnits: ItemUnitDto[] = itemUnitRows.map((iu) => {
      const factor = iu.qty > 0 ? iu.qty : 1;
      const pool = iu.isStockUnit ? iu.unit?.code ?? '' : '';
      return {
        unitName: iu.unit?.nameAr ?? iu.unit?.nameEn ?? '',
        unitCode: iu.barcode,
        itemUnitId: iu.id,
        isStockUnit: iu.isStockUnit,
        unitPrice: toPrice3(iu.salePrice),
        unitQty: String(Math.floor((poolQty.get(pool) ?? 0) / factor)),
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
    // On-van inventory = the posted-voucher `item_balance` ledger for the rep's van
    // store (same source as the dashboard + SALE stock check). Stock appears here
    // once a load/transfer voucher into the van is posted.
    const store = rep.vanId
      ? (await this.warehouses.findOne({ where: { id: rep.vanId } }))?.whNumber ?? null
      : null;
    if (!store) return [];

    // The ledger now returns one row per (item, pool). An item is on the van
    // when ANY of its pools is non-zero — an item with no base pieces left but
    // 100 red ones is still loaded.
    const balRows = await this.balances.find({ where: { stockNumber: store } });
    const loaded = balRows.filter((b) => Number(b.qty) !== 0);
    if (loaded.length === 0) return [];

    // itemNumber → pool ('' = base pieces) → qty.
    const poolQty = new Map<string, Map<string, number>>();
    for (const b of loaded) {
      const pools = poolQty.get(b.itemNumber) ?? new Map<string, number>();
      pools.set(b.stockUnitCode ?? '', Math.trunc(Number(b.qty)));
      poolQty.set(b.itemNumber, pools);
    }
    const itemNumbers = [...new Set(loaded.map((b) => b.itemNumber))];
    const items = await this.items.find({
      where: { itemNumber: In(itemNumbers), deletedAt: IsNull() },
    });
    const itemIds = items.map((i) => i.id);

    const ius = await this.itemUnitsRepo.find({
      where: { itemId: In(itemIds) },
      relations: { unit: true },
      order: { unit: { baseQty: 'ASC' } },
    });
    const unitsByItem = new Map<string, Array<Record<string, unknown>>>();
    const itemNumberById = new Map(items.map((i) => [i.id, i.itemNumber]));
    for (const iu of ius) {
      const arr = unitsByItem.get(iu.itemId) ?? [];
      // The factor is item_units.qty (§4.1); units.base_qty is only the default
      // a fresh attachment starts from.
      const factor = iu.qty > 0 ? iu.qty : 1;
      const pool = iu.isStockUnit ? iu.unit?.code ?? '' : '';
      const available =
        poolQty.get(itemNumberById.get(iu.itemId) ?? '')?.get(pool) ?? 0;
      arr.push({
        unitId: iu.unitId,
        itemUnitId: iu.id,
        unitCode: iu.unit?.code ?? '',
        unitName: iu.unit?.nameAr ?? '',
        unitNameEn: iu.unit?.nameEn ?? null,
        qty: factor,
        isBase: iu.unit?.code === 'PCE',
        isStockUnit: iu.isStockUnit,
        // How many of THIS unit the van holds: a variant's own pool, or what
        // the shared base pool can make up for a packaging unit.
        quantity: Math.floor(available / factor),
        barcode: iu.barcode,
        salePrice: Number(iu.salePrice).toFixed(3),
      });
      unitsByItem.set(iu.itemId, arr);
    }

    // `quantity` on the item stays the BASE pool, so a client that ignores
    // units keeps reading exactly what it read before.
    return items.map((item) => ({
      ...item,
      quantity: poolQty.get(item.itemNumber)?.get('') ?? 0,
      units: unitsByItem.get(item.id) ?? [],
    }));
  }

  async getItemBalance(
    itemNumber: string,
    storeNo: string | undefined,
    _rep: Rep,
    companyNumber: string,
    salesmanCode: string,
  ): Promise<ItemBalanceRowDto[]> {
    // Single source of truth: the posted-voucher `item_balance` ledger — the SAME
    // table the dashboard and the SALE stock check read, so device and server agree.
    // (Stock lands in a store/van only after a posted load/transfer voucher.)
    const qb = this.balances
      .createQueryBuilder('b')
      .where('b.item_number = :itemNumber', { itemNumber })
      .andWhere('b.stock_number IS NOT NULL');
    if (storeNo) qb.andWhere('b.stock_number = :s', { s: storeNo });
    const rows = await qb.orderBy('b.stock_number', 'ASC').getMany();

    // Overlay the ERP's authoritative on-hand for WAREHOUSE stores (the book of
    // record), so an ERP in/out/transfer reflects immediately. VAN stores are
    // deliberately left on the local ledger — it drops the instant the salesman
    // sells, whereas the ERP lags his un-synced sales (overselling risk). Any
    // pool the ERP does not report, and any ERP outage, keeps the local qty.
    const [live, vanStores] = await Promise.all([
      this.erpSync.liveErpQtyIndex({ itemNumbers: [itemNumber], stockNumber: storeNo }),
      this.erpSync.vanStoreNumbers(),
    ]);
    const qtyOf = (r: ItemBalanceView): number => {
      const store = r.stockNumber ?? '';
      if (!live.live || vanStores.has(store)) return Number(r.qty);
      const erp = live.qty.get(`${store}|${r.itemNumber}|${r.stockUnitCode ?? ''}`);
      return erp === undefined ? Number(r.qty) : erp;
    };

    return rows.map((r) => ({
      companyNumber,
      salesmanCode,
      itemNumber: r.itemNumber,
      // One row per pool now — a variant's stock is its own, so it is reported
      // as its own row rather than folded into the item's total.
      stockUnitCode: r.stockUnitCode ?? '',
      itemQty: String(Math.trunc(qtyOf(r))),
      storeNumber: r.stockNumber as string,
    }));
  }

  /**
   * The MAIN STORE that van ORDERS are fulfilled from.
   *
   * An order is a request for a central-depot voucher, NOT a draw on the van, so
   * its quantities come from here — never the salesman's van. Resolution order:
   * the admin-configured `main_store_number` setting, else the ERP default depot
   * (approximated as the lowest-numbered non-van warehouse). Returns null only
   * when no depot exists at all.
   */
  async resolveMainStore(): Promise<{ number: string; name: string | null } | null> {
    // 1) An explicit admin override always wins.
    const cfg = await this.settings.findOne({ where: { id: 1 } });
    if (cfg?.mainStoreNumber) {
      const wh = await this.warehouses.findOne({ where: { whNumber: cfg.mainStoreNumber } });
      return { number: cfg.mainStoreNumber, name: wh?.whName ?? null };
    }
    // 2) The store the ERP itself flags as main (mirrored onto is_main each sync).
    //    This is the real detection — it survives a settings reset because the next
    //    warehouse sync sets it again.
    const flagged = await this.warehouses.findOne({
      where: { isMain: true, isVan: false },
    });
    if (flagged) return { number: flagged.whNumber, name: flagged.whName ?? null };
    // 3) Last resort when the ERP flags none: the lowest-numbered depot.
    const depots = await this.warehouses.find({ where: { isVan: false } });
    if (!depots.length) return null;
    const first = [...depots].sort((a, b) =>
      a.whNumber.localeCompare(b.whNumber, undefined, { numeric: true }),
    )[0];
    return { number: first.whNumber, name: first.whName ?? null };
  }

  /**
   * Item quantities for the ORDER flow — read from the MAIN STORE, not the van.
   *
   * Because an order draws from a central depot, the quantity comes live from the
   * ERP's authoritative on-hand for the main store (a depot, so no van overselling
   * caveat), falling back to the local posted-voucher ledger only when the ERP is
   * unavailable. Any salesman may order — including a credit salesman who has no
   * van at all. Mirrors getItemBalance's row shape so the app can reuse the picker.
   * Optionally narrowed to one item.
   */
  async getOrderStock(
    itemNumber: string | undefined,
    companyNumber: string,
    salesmanCode: string,
  ): Promise<ItemBalanceRowDto[]> {
    const main = await this.resolveMainStore();
    if (!main) return [];

    // Live ERP on-hand for the main store — the book of record for quantities, but
    // its broad snapshot silently DROPS any SKU it can't map back to a cash-van
    // item (resolveStockTarget → continue). That is how main-store items went
    // missing from the ORDER picker. So it is used for quantities, not membership.
    const live = await this.erpSync
      .liveErpStock({
        itemNumbers: itemNumber ? [itemNumber] : [],
        stockNumber: main.number,
      })
      .catch(() => null);
    const liveQty = new Map<string, number>();
    if (live?.source === 'erp') {
      for (const r of live.rows) {
        if (r.stockNumber !== main.number) continue;
        liveQty.set(`${r.itemNumber}|${r.stockUnitCode ?? ''}`, r.quantity);
      }
    }

    // The local ledger is the COMPLETE list of items the main store carries — it
    // never drops an item the live snapshot couldn't map. Base the picker on it so
    // EVERY main-store item shows, and overlay the live quantity where we have it
    // (live wins on quantity, and also contributes any pool not yet booked locally).
    const qb = this.balances
      .createQueryBuilder('b')
      .where('b.stock_number = :s', { s: main.number });
    if (itemNumber) qb.andWhere('b.item_number = :itemNumber', { itemNumber });
    const ledger = await qb.orderBy('b.item_number', 'ASC').getMany();

    const out = new Map<string, ItemBalanceRowDto>();
    const put = (item: string, pool: string, qty: number) => {
      out.set(`${item}|${pool}`, {
        companyNumber,
        salesmanCode,
        itemNumber: item,
        stockUnitCode: pool,
        itemQty: String(Math.trunc(qty)),
        storeNumber: main.number,
      });
    };
    for (const r of ledger) put(r.itemNumber, r.stockUnitCode ?? '', Number(r.qty) || 0);
    for (const [key, qty] of liveQty) {
      const sep = key.indexOf('|');
      put(key.slice(0, sep), key.slice(sep + 1), qty);
    }
    return [...out.values()];
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
