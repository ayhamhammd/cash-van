import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { Warehouse } from '../warehouses/entities/warehouse.entity';
import { Rep } from '../reps/entities/rep.entity';
import { provisionRep } from '../reps/rep-provision';
import { Customer } from '../customers/entities/customer.entity';
import { Collection } from '../collections/entities/collection.entity';
import { VoucherHeader } from '../vouchers/entities/voucher-header.entity';
import { VoucherTransaction } from '../vouchers/entities/voucher-transaction.entity';
import { SettingsService } from '../settings/settings.service';
import { VouchersService } from '../vouchers/vouchers.service';
import { ErpHttpClient } from './erp-http.client';
import { ErpOutboxService } from './erp-outbox.service';
import { ErpIdMap } from './entities/erp-id-map.entity';
import { ErpSyncCursor } from './entities/erp-sync-cursor.entity';
import { ErpOutboxKind } from './entities/erp-outbox.entity';

/** cash-van voucher kind → ERP outbox kind (per-kind outbound, same kind preserved). */
const OUTBOX_KIND_BY_TRANS: Record<string, ErpOutboxKind | undefined> = {
  SALE: 'SALE_INVOICE',
  RETURN: 'SALES_RETURN',
  ORDER: 'SALES_ORDER',
  IN: 'STOCK_ADJUSTMENT',
  OUT: 'STOCK_ADJUSTMENT',
  TRANSFER: 'STOCK_TRANSFER',
};

/** A SKU row from the ERP `GET /api/v1/skus` (prices already in major units). */
interface ErpSku {
  id: string;
  sku: string;
  label?: string;
  barcode?: string | null;
  sellingPrice?: number | string;
  unitCost?: number | string;
  productName?: string;
  isActive?: boolean;
}

/** A warehouse row from the ERP `GET /api/v1/warehouses`. */
interface ErpWarehouse {
  id: string;
  code?: string | null;
  name?: string;
  isVan?: boolean;
  isMain?: boolean;
}

/** A receipt row from the ERP `GET /api/v1/receipts` (customer payments feed). */
interface ErpReceipt {
  id: string;
  customerCode: string | null;
  amount: number | string; // major units
  note?: string | null;
  createdAt?: string | null;
}

/** A ledger row from the ERP `GET /api/v1/stock-movements` (the inbound feed). */
interface ErpMovement {
  id: string;
  type: string | null;
  skuCode: string;
  quantityChanged: number | string; // signed: + into the warehouse, − out
  warehouseCode: string;
  reason?: string | null;
  createdAt?: string | null;
}

/** Organization (company) settings from the ERP `GET /api/v1/organization`. */
interface ErpOrg {
  name?: string | null;
  currencyCode?: string | null;
  salesTaxMode?: string | null;
}

export interface SyncEntityResult {
  entity: string;
  count: number;
  status: 'ok' | 'failed' | 'skipped';
  error?: string;
}

@Injectable()
export class ErpSyncService {
  private readonly logger = new Logger(ErpSyncService.name);
  private pulling = false;

  constructor(
    private readonly erp: ErpHttpClient,
    private readonly settings: SettingsService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ItemCart) private readonly items: Repository<ItemCart>,
    @InjectRepository(Warehouse) private readonly whs: Repository<Warehouse>,
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(Collection) private readonly collections: Repository<Collection>,
    @InjectRepository(VoucherHeader) private readonly headers: Repository<VoucherHeader>,
    @InjectRepository(VoucherTransaction) private readonly txns: Repository<VoucherTransaction>,
    @InjectRepository(ErpIdMap) private readonly idmap: Repository<ErpIdMap>,
    @InjectRepository(ErpSyncCursor) private readonly cursors: Repository<ErpSyncCursor>,
    private readonly vouchers: VouchersService,
    private readonly outbox: ErpOutboxService,
  ) {}

  /** Queue a posted cash-van voucher for push to the ERP, by kind. */
  @OnEvent('erp.voucher.posted')
  async onVoucherPosted(p: { voucherNumber: string; transKind: string }): Promise<void> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled) return;
    // Never push back a voucher we mirrored IN from the ERP (loop guard).
    if (p.voucherNumber.startsWith('ERP-')) return;
    const kind = OUTBOX_KIND_BY_TRANS[p.transKind];
    if (kind) await this.outbox.enqueue(kind, p.voucherNumber);
  }

  /**
   * Mirror a cash-van salesman's van store into the ERP as a van warehouse
   * (called on rep create). Best-effort + idempotent (ERP dedups on code).
   */
  async pushWarehouse(code: string, name: string, isVan: boolean): Promise<void> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey) return;
    try {
      const res = await this.erp.post('warehouses', { code, name, isVan }, code);
      if (res.ok) {
        const erpId = (res.data as { data?: { id?: string } } | null)?.data?.id ?? code;
        await this.upsertIdMap('warehouse', erpId, code, code);
      } else {
        this.logger.warn(`pushWarehouse ${code} rejected: ${res.error}`);
      }
    } catch (e) {
      this.logger.warn(`pushWarehouse ${code} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Per-entity cursor + last-run summary for the dashboard. */
  status(): Promise<ErpSyncCursor[]> {
    return this.cursors.find();
  }

  // ── Create-mirror (dashboard → ERP), event-driven to avoid module cycles ──

  @OnEvent('erp.customer.created')
  onCustomerCreated(p: { code: string; name: string; phone?: string | null }): Promise<void> {
    return this.pushCustomer(p.code, p.name, p.phone ?? undefined);
  }

  @OnEvent('erp.item.created')
  onItemCreated(p: {
    itemNumber: string;
    name: string;
    priceFils: number;
    costFils?: number;
  }): Promise<void> {
    return this.pushItem(p.itemNumber, p.name, p.priceFils, p.costFils ?? 0);
  }

  /** A confirmed collection → an ERP customer receipt (best-effort, ERP off = no-op). */
  @OnEvent('erp.collection.confirmed')
  async onCollectionConfirmed(p: { collectionId: string }): Promise<void> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled) return;
    await this.outbox.enqueue('PAYMENT', p.collectionId);
  }

  /** Mirror cash-van company name + tax mode into the ERP org settings. */
  @OnEvent('erp.settings.updated')
  async onSettingsUpdated(p: { name: string; salesTaxMode: string }): Promise<void> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey) return;
    try {
      await this.erp.patch('organization', { name: p.name, salesTaxMode: p.salesTaxMode });
    } catch (e) {
      this.logger.warn(`pushOrganization failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Pull ERP org settings → cash-van company name + tax mode. */
  private async pullOrganization(): Promise<number> {
    const org = await this.erp.getOne<ErpOrg>('organization');
    if (!org) return 0;
    await this.settings.applyErpOrg(org.name ?? null, org.salesTaxMode ?? null);
    return 1;
  }

  /** Mirror a cash-van customer into the ERP (idempotent on code). */
  async pushCustomer(code: string, name: string, phone?: string): Promise<void> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey) return;
    try {
      const res = await this.erp.post('customers', { code, name, ...(phone ? { phone } : {}) }, code);
      if (res.ok) {
        const erpId = (res.data as { data?: { id?: string } } | null)?.data?.id ?? code;
        await this.upsertIdMap('customer', erpId, code, code);
      } else {
        this.logger.warn(`pushCustomer ${code} rejected: ${res.error}`);
      }
    } catch (e) {
      this.logger.warn(`pushCustomer ${code} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Mirror a cash-van item into the ERP as a product+base SKU (idempotent on code). */
  async pushItem(
    itemNumber: string,
    name: string,
    priceFils: number,
    costFils = 0,
  ): Promise<void> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey) return;
    if (!cfg.defaultCategoryId || !cfg.defaultTaxRateId) {
      this.logger.warn(`pushItem ${itemNumber} skipped: ERP default category/tax not configured`);
      return;
    }
    try {
      const res = await this.erp.post(
        'products',
        {
          code: itemNumber,
          name,
          categoryId: cfg.defaultCategoryId,
          taxRateId: cfg.defaultTaxRateId,
          unitCost: costFils / 1000, // product-level cost (fils → major)
          sellingPrice: priceFils / 1000, // product-level price (fils → major)
          // The base SKU carries its OWN price/cost (that's what /skus exposes).
          baseUnit: {
            name: 'Each',
            sku: itemNumber,
            unitCost: costFils / 1000,
            sellingPrice: priceFils / 1000,
          },
        },
        itemNumber,
      );
      if (res.ok) {
        const erpId = (res.data as { data?: { id?: string } } | null)?.data?.id ?? itemNumber;
        await this.upsertIdMap('item', erpId, itemNumber, itemNumber);
      } else {
        this.logger.warn(`pushItem ${itemNumber} rejected: ${res.error}`);
      }
    } catch (e) {
      this.logger.warn(`pushItem ${itemNumber} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Automatic inbound pull every 60s when ERP mode is on, so items / stock /
   * receipts / warehouses created in the ERP reflect on the dashboard without a
   * manual "Sync now". (Outbound is already automatic via events + the outbox
   * drain.) Guarded against overlap with itself and a manual sync.
   */
  @Interval(60000)
  async scheduledPull(): Promise<void> {
    if (this.pulling) return;
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey) return;
    this.pulling = true;
    try {
      await this.syncNow();
    } catch (e) {
      this.logger.warn(`scheduled ERP pull failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.pulling = false;
    }
  }

  /** Run an inbound pull now (admin "Sync now"). No-op when ERP mode is off. */
  async syncNow(): Promise<SyncEntityResult[]> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.enabled) {
      return [{ entity: 'all', count: 0, status: 'skipped', error: 'ERP mode is off' }];
    }
    const results = [
      await this.runEntity('organization', () => this.pullOrganization()),
      await this.runEntity('warehouse', () => this.pullWarehouses()),
      await this.runEntity('item', () => this.pullItems()),
    ];
    // Mirror ERP stock movements for every van store (each salesman's code).
    const reps = await this.reps.find({ select: { code: true } });
    const stores = [...new Set(reps.map((r) => r.code).filter((c): c is string => !!c))];
    for (const store of stores) {
      results.push(
        await this.runEntity(`movements:${store}`, () => this.pullMovementsForVan(store)),
      );
    }
    // ERP-native customer receipts → cash-van collections (customer-scoped).
    results.push(await this.runEntity('receipts', () => this.pullReceipts()));
    return results;
  }

  /**
   * Inbound mirror (ERP → cash-van) of customer payment receipts. The ERP feed
   * already excludes our own pushed receipts (van_sales-tagged), so only
   * ERP-native receipts arrive. Each becomes a confirmed cash-van collection,
   * attributed to the customer's assigned rep. Receipts for unknown customers or
   * customers with no rep are skipped (can't attribute a collection).
   */
  private async pullReceipts(): Promise<number> {
    const cursor = await this.cursors.findOne({ where: { entity: 'receipts' } });
    const since = cursor?.updatedSince ? cursor.updatedSince.toISOString() : undefined;
    let n = 0;
    let maxTs = cursor?.updatedSince ?? null;
    let page = 1;
    for (;;) {
      const { data } = await this.erp.list<ErpReceipt>('receipts', { since, page, pageSize: 200 });
      if (data.length === 0) break;
      for (const r of data) {
        const ts = r.createdAt ? new Date(r.createdAt) : null;
        if (ts && (!maxTs || ts > maxTs)) maxTs = ts;
        const seen = await this.idmap.findOne({ where: { entity: 'receipt', erpId: r.id } });
        if (seen) continue;
        if (!r.customerCode) continue;
        const customer = await this.customers.findOne({
          where: { customerNumber: r.customerCode },
        });
        if (!customer?.repId) continue; // unknown customer / unassigned → can't attribute
        const collection = await this.collections.save(
          this.collections.create({
            repId: customer.repId,
            customerId: customer.id,
            amount: Math.round((Number(r.amount) || 0) * 1000), // major → fils
            method: 'cash',
            status: 'confirmed',
            collectedAt: ts ?? new Date(),
            confirmedAt: new Date(),
            // ERP receipt id is tracked in erp_id_map (payment_id has a local FK).
            note: r.note ?? null,
          }),
        );
        await this.upsertIdMap('receipt', r.id, null, collection.id);
        n += 1;
      }
      if (data.length < 200) break;
      page += 1;
      if (page > 50) break;
    }
    if (maxTs) {
      const c = cursor ?? this.cursors.create({ entity: 'receipts' });
      c.updatedSince = maxTs;
      await this.cursors.save(c);
    }
    return n;
  }

  /**
   * Inbound mirror (ERP → cash-van) for ONE van warehouse. Pulls the ERP
   * stock-movement ledger since the per-van cursor and creates a REAL,
   * stock-affecting cash-van voucher of the SAME kind for each movement (SALE,
   * RETURN, TRANSFER, IN, OUT). The ERP feed already excludes cash-van's own
   * pushes (made by the integration user), so this never echoes our outbound
   * documents; the `ERP-MV-` prefix + a 'movement' id-map row also dedup and
   * stop the posted-event handler from pushing them back.
   */
  private async pullMovementsForVan(store: string): Promise<number> {
    const entity = `movements:${store}`;
    const cursor = await this.cursors.findOne({ where: { entity } });
    const since = cursor?.updatedSince ? cursor.updatedSince.toISOString() : undefined;
    let n = 0;
    let maxTs = cursor?.updatedSince ?? null;
    let page = 1;
    for (;;) {
      const { data } = await this.erp.list<ErpMovement>('stock-movements', {
        warehouseCode: store,
        since,
        page,
        pageSize: 200,
      });
      if (data.length === 0) break;
      for (const mv of data) {
        const ts = mv.createdAt ? new Date(mv.createdAt) : null;
        if (ts && (!maxTs || ts > maxTs)) maxTs = ts;
        const seen = await this.idmap.findOne({ where: { entity: 'movement', erpId: mv.id } });
        if (seen) continue;
        await this.mirrorMovement(mv, store);
        n += 1;
      }
      if (data.length < 200) break;
      page += 1;
      if (page > 50) break; // safety cap (10k movements / run)
    }
    if (maxTs) {
      const c = cursor ?? this.cursors.create({ entity });
      c.updatedSince = maxTs;
      await this.cursors.save(c);
    }
    return n;
  }

  /** ERP movement `type` (+ sign) → cash-van voucher kind, preserving the kind. */
  private classifyKind(type: string | null, qty: number): string {
    const t = (type ?? '').toLowerCase();
    if (t.includes('sale')) return 'SALE';
    if (t.includes('return')) return 'RETURN';
    if (t.includes('transfer')) return 'TRANSFER';
    if (t.includes('out')) return 'OUT';
    if (t.includes('in') || t.includes('purchase') || t.includes('receipt') || t.includes('initial'))
      return 'IN';
    return qty > 0 ? 'IN' : 'OUT';
  }

  /** Create a real, stock-affecting cash-van voucher mirroring one ERP movement. */
  private async mirrorMovement(mv: ErpMovement, store: string): Promise<void> {
    const qty = Number(mv.quantityChanged) || 0;
    if (qty === 0) return; // cost-only / no stock effect
    const into = qty > 0; // positive → stock enters this warehouse
    const abs = Math.abs(qty);
    const kind = this.classifyKind(mv.type, qty);
    const voucherNumber = `ERP-MV-${mv.id}`;
    const item = await this.items.findOne({ where: { itemNumber: mv.skuCode } });

    const header = this.headers.create({
      voucherNumber,
      transKind: kind,
      userCode: 'admin',
      referenceVoucherNumber: null,
      inDate: mv.createdAt ? new Date(mv.createdAt) : new Date(),
      total: '0',
      totalTax: '0',
      netTotal: '0',
      totalDiscountValue: '0',
      totalDiscountPercentage: '0',
      isPosted: true,
      isEdit: false,
    });
    await this.headers.save(header);

    // from/to stores drive the item_balance view — set the van's side by sign.
    const txn = this.txns.create({
      voucherNumber,
      itemNumber: mv.skuCode,
      itemName: item?.name ?? mv.skuCode,
      transKind: kind,
      storeNumber: store,
      fromStoreNumber: into ? null : store,
      toStoreNumber: into ? store : null,
      itemQty: String(abs),
      unitPrice: '0',
      qtyOfUnit: String(abs),
      unitBaseQty: 1,
      signedQty: String(into ? abs : -abs),
      taxPercentage: '0',
      discountPercentage: '0',
      discountValue: '0',
      total: '0',
      netTotal: '0',
    });
    await this.txns.save(txn);
    await this.upsertIdMap('movement', mv.id, mv.skuCode, voucherNumber);
  }

  private async runEntity(
    entity: string,
    fn: () => Promise<number>,
  ): Promise<SyncEntityResult> {
    try {
      const count = await fn();
      await this.saveCursor(entity, 'ok', count, null);
      return { entity, count, status: 'ok' };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.warn(`ERP sync ${entity} failed: ${error}`);
      await this.saveCursor(entity, 'failed', 0, error);
      return { entity, count: 0, status: 'failed', error };
    }
  }

  /**
   * Pull ERP warehouses → upsert cash-van stores. Every VAN warehouse also
   * gets a local salesman (rep + login user) provisioned if none exists yet, so
   * a salesman created in the ERP reflects to the dashboard (two-way with
   * RepsService.create, which pushes the other direction).
   */
  private async pullWarehouses(): Promise<number> {
    const { data } = await this.erp.list<ErpWarehouse>('warehouses', { page: 1, pageSize: 200 });
    let n = 0;
    for (const w of data) {
      if (!w.code) continue; // only warehouses with an external code are syncable
      let wh = await this.whs.findOne({ where: { whNumber: w.code } });
      if (!wh) wh = this.whs.create({ whNumber: w.code });
      wh.whName = w.name ?? w.code;
      await this.whs.save(wh);
      await this.upsertIdMap('warehouse', w.id, w.code, w.code);

      // A van warehouse is a salesman — provision rep + login if none exists.
      // Include soft-deleted reps: the unique code index ignores deleted_at, and
      // an admin who deleted a salesman shouldn't have them auto-resurrected.
      if (w.isVan) {
        const existing = await this.reps.findOne({
          where: { code: w.code },
          withDeleted: true,
        });
        if (!existing) {
          await this.dataSource.transaction((em) =>
            provisionRep(em, { code: w.code!, nameAr: w.name ?? w.code! }),
          );
        }
      }
      n += 1;
    }
    return n;
  }

  /** Pull the ERP catalog (SKUs) → upsert item_cart, paging through all rows. */
  private async pullItems(): Promise<number> {
    const pageSize = 100;
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    let processed = 0;
    while (processed < total) {
      const { data, total: t } = await this.erp.list<ErpSku>('skus', { page, pageSize });
      total = t;
      if (data.length === 0) break;
      for (const row of data) await this.upsertItem(row);
      processed += data.length;
      page += 1;
      if (page > 200) break; // safety cap (20k items)
    }
    return processed;
  }

  private async upsertItem(row: ErpSku): Promise<void> {
    const itemNumber = row.sku;
    if (!itemNumber) return;
    let item = await this.items.findOne({ where: { itemNumber } });
    if (!item) item = this.items.create({ itemNumber });
    const label = row.label ?? row.productName ?? row.sku;
    item.sku = row.sku;
    item.name = label;
    item.nameAr = item.nameAr || label; // don't clobber a curated Arabic name
    item.nameEn = label;
    item.barcode = row.barcode || row.sku; // cash-van barcode is required + unique
    item.price = Math.round((Number(row.sellingPrice) || 0) * 1000); // major → fils
    item.cost = Math.round((Number(row.unitCost) || 0) * 1000); // major → fils
    item.isActive = row.isActive ?? true;
    await this.items.save(item);
    // localId = itemNumber (the stable cross-system key), erpId = ERP sku UUID.
    await this.upsertIdMap('item', String(row.id), row.sku, itemNumber);
  }

  private async upsertIdMap(
    entity: string,
    erpId: string,
    erpCode: string | null,
    localId: string,
  ): Promise<void> {
    let m = await this.idmap.findOne({ where: { entity, erpId } });
    if (!m) m = this.idmap.create({ entity, erpId });
    m.erpCode = erpCode;
    m.localId = localId;
    await this.idmap.save(m);
  }

  private async saveCursor(
    entity: string,
    status: string,
    count: number,
    error: string | null,
  ): Promise<void> {
    let c = await this.cursors.findOne({ where: { entity } });
    if (!c) c = this.cursors.create({ entity });
    c.lastRunAt = new Date();
    c.lastStatus = status;
    c.lastCount = count;
    c.lastError = error;
    await this.cursors.save(c);
  }
}
