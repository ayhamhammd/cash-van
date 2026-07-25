import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { TobaccoTaxProfile } from '../items/entities/tobacco-tax-profile.entity';
import { Warehouse } from '../warehouses/entities/warehouse.entity';
import { Rep } from '../reps/entities/rep.entity';
import { provisionRep } from '../reps/rep-provision';
import { Customer } from '../customers/entities/customer.entity';
import { Unit } from '../units/entities/unit.entity';
import { ItemUnit } from '../units/entities/item-unit.entity';
import { ProductCategory } from '../products/entities/product-category.entity';
import { CustomerPrice } from '../products/entities/customer-price.entity';
import { PriceList } from '../products/entities/price-list.entity';
import { PriceListItem } from '../products/entities/price-list-item.entity';
import { Collection } from '../collections/entities/collection.entity';
import { VoucherHeader } from '../vouchers/entities/voucher-header.entity';
import { VoucherTransaction } from '../vouchers/entities/voucher-transaction.entity';
import { SettingsService } from '../settings/settings.service';
import { VouchersService } from '../vouchers/vouchers.service';
import { ErpHttpClient } from './erp-http.client';
import { ErpOutboxService } from './erp-outbox.service';
import { ErpIdMap } from './entities/erp-id-map.entity';
import { ErpSyncCursor } from './entities/erp-sync-cursor.entity';
import { ErpStockSnapshot } from './entities/erp-stock-snapshot.entity';
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
  /** The unit name for this SKU (e.g. حبة / طرد). Same as `label` on the ERP. */
  unitLabel?: string;
  barcode?: string | null;
  sellingPrice?: number | string;
  unitCost?: number | string;
  /** The real product name, shared across all of a product's unit-SKUs. */
  productName?: string;
  /** Groups all unit-SKUs of one product. */
  productId?: string;
  /** True for the base (smallest) sellable unit — its multiplier is 1. */
  isBaseUnit?: boolean;
  /** Pieces (base units) this SKU's unit represents (1 for base, 30 for a طرد of 30). */
  unitMultiplier?: number | string;
  isActive?: boolean;
  /** Product image URL (relative to the ERP origin, e.g. /uploads/<org>/x.png). */
  imageUrl?: string | null;
  // ── Tobacco tax (resolved SKU→product on the ERP; see /skus) ────────────────
  isTobaccoProduct?: boolean;
  tobaccoTaxProfileId?: string | null; // ERP profile id
  consumerPrice?: number | string | null; // JOD major
}

/** A tobacco tax profile from the ERP `GET /api/v1/tobacco-tax-profiles`. */
interface ErpTobaccoProfile {
  id: string;
  name: string;
  description?: string | null;
  taxBase: string;
  salesTaxEnabled: boolean;
  salesTaxRate: number;
  specialTaxEnabled: boolean;
  specialTaxCalculationType: string;
  specialTaxBase: string;
  specialTaxRate?: number | null;
  specialTaxFixedAmount?: number | string | null; // JOD major per unit
  withheldTaxEnabled: boolean;
  withheldTaxCalculationType: string;
  withheldTaxBase: string;
  withheldTaxAmount?: number | string | null; // JOD major per unit
  withheldTaxRate?: number | null;
  taxIncludedInConsumerPrice?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
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

/** A snapshot row from the ERP `GET /api/v1/van/stock` (current on-hand, org-wide). */
interface ErpVanStockRow {
  skuId?: string;
  skuCode: string;
  warehouseId: string;
  warehouseName?: string;
  quantity: number | string;
  reservedQuantity?: number | string;
  availableQuantity?: number | string;
}

/** A category row from the ERP `GET /api/v1/categories`. */
interface ErpCategory {
  id: string;
  name: string;
  levelIndex?: number;
  parentId?: string | null;
}

/** A unit row from the ERP `GET /api/v1/units` (deduped master). */
interface ErpUnit {
  name: string;
  multiplier?: number | string;
  isBase?: boolean;
}

/** A customer row from the ERP `GET /api/v1/customers`. */
interface ErpCustomer {
  id: string;
  code: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  taxNumber?: string | null;
  creditLimit?: number | string | null; // ERP stores thousandths
  paymentTermsDays?: number | null;      // AR: Net-N terms
  creditHold?: boolean | null;           // AR: hard-stop all credit sales
  priceListId?: string | null;
  priceListName?: string | null;
  allowManualPriceEdit?: boolean | null;
}

/** A per-customer aging row from the ERP `GET /api/v1/ar/aging`. */
interface ErpAgingRow {
  customerId: string;
  customerCode?: string | null;
  totalOpen?: number | null;   // open receivable, major units
  overdue?: number | null;     // past-due portion, major units
}

/** A resolved price row from the ERP `GET /api/v1/prices?customerCode=`. */
interface ErpPrice {
  skuId?: string;
  skuCode: string;
  barcode?: string | null;
  productName?: string;
  price?: number | string; // ERP major units
  currency?: string | null;
  /** PRICE_LIST | CUSTOMER_PRICE | DEFAULT_PRICE */
  priceSource?: string | null;
}

/** A price list from the ERP `GET /api/v1/price-lists`. */
interface ErpPriceList {
  id: string;
  code: string;
  name: string;
  isActive?: boolean;
}

/** `GET /api/v1/price-lists/{id}` → the list + its items. */
interface ErpPriceListDetail extends ErpPriceList {
  items?: Array<{
    skuCode: string;
    price: number | string; // ERP major units
    minQty?: number | null;
  }>;
}

/** Organization (company) settings from the ERP `GET /api/v1/organization`. */
interface ErpOrg {
  name?: string | null;
  logoUrl?: string | null;
  address?: string | null;
  phone?: string | null;
  taxNumber?: string | null;
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
  private webhookTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly erp: ErpHttpClient,
    private readonly settings: SettingsService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ItemCart) private readonly items: Repository<ItemCart>,
    @InjectRepository(TobaccoTaxProfile) private readonly tobaccoProfiles: Repository<TobaccoTaxProfile>,
    @InjectRepository(Warehouse) private readonly whs: Repository<Warehouse>,
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(Unit) private readonly units: Repository<Unit>,
    @InjectRepository(ItemUnit) private readonly itemUnits: Repository<ItemUnit>,
    @InjectRepository(CustomerPrice) private readonly customerPrices: Repository<CustomerPrice>,
    @InjectRepository(PriceList) private readonly priceLists: Repository<PriceList>,
    @InjectRepository(PriceListItem) private readonly priceListItems: Repository<PriceListItem>,
    @InjectRepository(ProductCategory) private readonly productCategories: Repository<ProductCategory>,
    @InjectRepository(Collection) private readonly collections: Repository<Collection>,
    @InjectRepository(VoucherHeader) private readonly headers: Repository<VoucherHeader>,
    @InjectRepository(VoucherTransaction) private readonly txns: Repository<VoucherTransaction>,
    @InjectRepository(ErpIdMap) private readonly idmap: Repository<ErpIdMap>,
    @InjectRepository(ErpSyncCursor) private readonly cursors: Repository<ErpSyncCursor>,
    @InjectRepository(ErpStockSnapshot) private readonly stockSnapshots: Repository<ErpStockSnapshot>,
    private readonly vouchers: VouchersService,
    private readonly outbox: ErpOutboxService,
  ) {}

  /** Queue a posted cash-van voucher for push to the ERP, by kind. */
  @OnEvent('erp.voucher.posted')
  async onVoucherPosted(p: { voucherNumber: string; transKind: string }): Promise<void> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled) return;
    // Manual-export mode: don't auto-push — the voucher waits in the ERP Export page.
    if (!cfg.directExport) return;
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

  /**
   * Wipe the van/stock baseline so the next pull re-seeds every (store, sku)
   * quantity WITHOUT posting adjustment vouchers for it (see `pullVanStock`: a
   * delta is only posted once a prior snapshot row exists). Run this ONCE right
   * after switching the ERP API key to a dedicated integration user, so stock
   * already reflected under the OLD key isn't replayed as a giant adjustment.
   * Admin only.
   */
  async catchUpMovements(): Promise<{ seeded: number; at: string }> {
    const now = new Date();
    const { affected } = await this.stockSnapshots
      .createQueryBuilder()
      .delete()
      .execute();
    return { seeded: affected ?? 0, at: now.toISOString() };
  }

  /** Passthrough: list ERP categories (for the item form). [] when ERP off. */
  async listErpCategories(): Promise<unknown[]> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey) return [];
    const { data } = await this.erp.list('categories');
    return data;
  }

  /** Passthrough: list ERP tax rates (for the item form). [] when ERP off. */
  async listErpTaxRates(): Promise<unknown[]> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey) return [];
    const { data } = await this.erp.list('tax-rates');
    return data;
  }

  /** Passthrough: list postable ERP GL accounts (for the cash-account link picker). [] when ERP off. */
  async listErpChartOfAccounts(): Promise<unknown[]> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey) return [];
    const { data } = await this.erp.list('chart-of-accounts');
    return data;
  }

  // ── Create-mirror (dashboard → ERP), event-driven to avoid module cycles ──

  @OnEvent('erp.customer.created')
  onCustomerCreated(p: {
    code: string;
    name: string;
    phone?: string | null;
    email?: string | null;
    taxNumber?: string | null;
    creditLimit?: number | null;
  }): Promise<void> {
    return this.pushCustomer(p.code, p.name, {
      phone: p.phone ?? undefined,
      email: p.email ?? undefined,
      taxNumber: p.taxNumber ?? undefined,
      creditLimit: p.creditLimit ?? undefined,
    });
  }

  /** A cash-van customer EDIT → PATCH the mapped ERP customer (or create if unmapped). */
  @OnEvent('erp.customer.updated')
  async onCustomerUpdated(p: {
    code: string;
    name: string;
    phone?: string | null;
    email?: string | null;
    taxNumber?: string | null;
    creditLimit?: number | null;
  }): Promise<void> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey) return;
    const map = await this.idmap.findOne({ where: { entity: 'customer', localId: p.code } });
    if (!map?.erpId) {
      // Not mirrored yet → create it (push handles id-map).
      return this.pushCustomer(p.code, p.name, {
        phone: p.phone ?? undefined,
        email: p.email ?? undefined,
        taxNumber: p.taxNumber ?? undefined,
        creditLimit: p.creditLimit ?? undefined,
      });
    }
    try {
      await this.erp.patch(`customers/${map.erpId}`, {
        name: p.name,
        phone: p.phone,
        email: p.email,
        taxNumber: p.taxNumber,
        ...(p.creditLimit != null ? { creditLimit: p.creditLimit } : {}),
      });
    } catch (e) {
      this.logger.warn(`pushCustomerUpdate ${p.code} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  @OnEvent('erp.item.created')
  onItemCreated(p: {
    itemNumber: string;
    name: string;
    priceFils: number;
    costFils?: number;
    erpCategoryId?: string | null;
    erpTaxRateId?: string | null;
  }): Promise<void> {
    return this.pushItem(p.itemNumber, p.name, p.priceFils, p.costFils ?? 0, {
      categoryId: p.erpCategoryId ?? undefined,
      taxRateId: p.erpTaxRateId ?? undefined,
    });
  }

  /** A confirmed collection → an ERP customer receipt (best-effort, ERP off = no-op). */
  @OnEvent('erp.collection.confirmed')
  async onCollectionConfirmed(p: { collectionId: string }): Promise<void> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled) return;
    // Manual-export mode: don't auto-push — the collection waits in the ERP Export page.
    if (!cfg.directExport) return;
    await this.outbox.enqueue('PAYMENT', p.collectionId);
  }

  // ── Manual export (used when directExport is OFF) ─────────────────────────

  /**
   * Pending manual-export queue: posted vouchers (SALE/RETURN/ORDER/TRANSFER/IN/OUT)
   * + confirmed collections that have NOT yet been queued/pushed to the ERP (no
   * `erp_outbox` row). Items/base-data are never here. Empty when ERP is off.
   */
  async listPendingExports(): Promise<{
    vouchers: Array<{
      voucherNumber: string;
      transKind: string;
      customerNumber: string | null;
      userCode: string;
      netTotal: string;
      inDate: Date;
    }>;
    collections: Array<{
      id: string;
      collectionNumber: string | null;
      amount: number;
      method: string;
      collectedAt: Date;
    }>;
  }> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled) return { vouchers: [], collections: [] };

    const kinds = Object.keys(OUTBOX_KIND_BY_TRANS);
    const vouchers = await this.headers
      .createQueryBuilder('vh')
      .where('vh.isPosted = true')
      .andWhere('vh.transKind IN (:...kinds)', { kinds })
      .andWhere("vh.voucherNumber NOT LIKE 'ERP-%'")
      .andWhere('NOT EXISTS (SELECT 1 FROM erp_outbox o WHERE o.ref = vh.voucher_number)')
      .orderBy('vh.inDate', 'DESC')
      .take(500)
      .getMany();

    const collections = await this.collections
      .createQueryBuilder('c')
      .where("c.status = 'confirmed'")
      .andWhere(
        "NOT EXISTS (SELECT 1 FROM erp_outbox o WHERE o.ref = c.id::text AND o.kind = 'PAYMENT')",
      )
      .orderBy('c.collectedAt', 'DESC')
      .take(500)
      .getMany();

    return {
      vouchers: vouchers.map((v) => ({
        voucherNumber: v.voucherNumber,
        transKind: v.transKind,
        customerNumber: v.customerNumber ?? null,
        userCode: v.userCode,
        netTotal: v.netTotal,
        inDate: v.inDate,
      })),
      collections: collections.map((c) => ({
        id: c.id,
        collectionNumber: c.collectionNumber ?? null,
        amount: c.amount,
        method: c.method,
        collectedAt: c.collectedAt,
      })),
    };
  }

  /** Manually queue ONE posted voucher for ERP export. */
  async exportVoucher(voucherNumber: string): Promise<{ queued: boolean }> {
    const h = await this.headers.findOne({ where: { voucherNumber } });
    if (!h) throw new NotFoundException(`Voucher ${voucherNumber} not found`);
    if (!h.isPosted) throw new BadRequestException('Only posted vouchers can be exported');
    if (voucherNumber.startsWith('ERP-')) {
      throw new BadRequestException('This voucher was mirrored from the ERP');
    }
    const kind = OUTBOX_KIND_BY_TRANS[h.transKind];
    if (!kind) throw new BadRequestException(`Voucher kind ${h.transKind} is not exportable`);
    await this.outbox.enqueue(kind, voucherNumber);
    return { queued: true };
  }

  /** Manually queue ONE confirmed collection for ERP export. */
  async exportCollection(id: string): Promise<{ queued: boolean }> {
    const c = await this.collections.findOne({ where: { id } });
    if (!c) throw new NotFoundException(`Collection ${id} not found`);
    if (c.status !== 'confirmed') {
      throw new BadRequestException('Only confirmed collections can be exported');
    }
    await this.outbox.enqueue('PAYMENT', id);
    return { queued: true };
  }

  /** Queue ALL pending vouchers + collections for export. */
  async exportAllPending(): Promise<{ vouchers: number; collections: number }> {
    const pending = await this.listPendingExports();
    for (const v of pending.vouchers) {
      const kind = OUTBOX_KIND_BY_TRANS[v.transKind];
      if (kind) await this.outbox.enqueue(kind, v.voucherNumber);
    }
    for (const c of pending.collections) {
      await this.outbox.enqueue('PAYMENT', c.id);
    }
    return { vouchers: pending.vouchers.length, collections: pending.collections.length };
  }

  /** Mirror cash-van company name + tax mode into the ERP org settings. */
  @OnEvent('erp.settings.updated')
  async onSettingsUpdated(p: {
    name: string;
    salesTaxMode: string;
    logoUrl?: string | null;
    address?: string | null;
    phone?: string | null;
    taxNumber?: string | null;
  }): Promise<void> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey) return;
    try {
      await this.erp.patch('organization', {
        name: p.name,
        // Tax mode is ERP-MASTERED: the ERP is the source of truth and the
        // dashboard PULLS it (pullOrganization → applyErpOrg). We deliberately do
        // NOT push salesTaxMode back, so the app/dashboard/ERP can never disagree.
        ...(p.logoUrl !== undefined ? { logoUrl: p.logoUrl } : {}),
        ...(p.address !== undefined ? { address: p.address } : {}),
        ...(p.phone !== undefined ? { phone: p.phone } : {}),
        ...(p.taxNumber !== undefined ? { taxNumber: p.taxNumber } : {}),
      });
    } catch (e) {
      this.logger.warn(`pushOrganization failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** On ERP (re)connect, pull company info from the ERP organization right away. */
  @OnEvent('erp.connected')
  async onErpConnected(): Promise<void> {
    try {
      await this.pullOrganization();
    } catch (e) {
      this.logger.warn(`on-connect org pull failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Pull ERP org settings → cash-van company name + tax mode. */
  private async pullOrganization(): Promise<number> {
    const org = await this.erp.getOne<ErpOrg>('organization');
    if (!org) return 0;
    await this.settings.applyErpOrg({
      name: org.name ?? null,
      salesTaxMode: org.salesTaxMode ?? null,
      logoUrl: org.logoUrl ?? null,
      address: org.address ?? null,
      phone: org.phone ?? null,
      taxNumber: org.taxNumber ?? null,
    });
    return 1;
  }

  /** Mirror a cash-van customer into the ERP (idempotent on code). */
  async pushCustomer(
    code: string,
    name: string,
    extra: { phone?: string; email?: string; taxNumber?: string; creditLimit?: number } = {},
  ): Promise<void> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey) return;
    try {
      const res = await this.erp.post(
        'customers',
        {
          code,
          name,
          ...(extra.phone ? { phone: extra.phone } : {}),
          ...(extra.email ? { email: extra.email } : {}),
          ...(extra.taxNumber ? { taxNumber: extra.taxNumber } : {}),
          ...(extra.creditLimit != null ? { creditLimit: extra.creditLimit } : {}), // JOD major; ERP ×1000
        },
        code,
      );
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
    erp: { categoryId?: string; taxRateId?: string } = {},
  ): Promise<void> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey) return;
    // Per-item ERP category/tax (chosen on the form) win; fall back to the defaults.
    const categoryId = erp.categoryId || cfg.defaultCategoryId;
    const taxRateId = erp.taxRateId || cfg.defaultTaxRateId;
    if (!categoryId || !taxRateId) {
      this.logger.warn(`pushItem ${itemNumber} skipped: no ERP category/tax (per-item or default)`);
      return;
    }
    try {
      const res = await this.erp.post(
        'products',
        {
          code: itemNumber,
          name,
          categoryId,
          taxRateId,
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
   * SAFETY-NET inbound pull every 5 min when ERP mode is on. The fast path is
   * the ERP webhook (`triggerWebhookSync`) which fires an immediate pull the
   * moment ERP data changes; this slow poll only reconciles anything a missed
   * webhook would have dropped. (Outbound is automatic via events + the outbox
   * drain.) Guarded against overlap with itself and a manual sync.
   */
  @Interval(300000)
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

  /**
   * Fast-path entry for the ERP webhook: schedule an immediate inbound pull,
   * debounced so a burst of ERP changes (e.g. a transfer = 2 movements, or a
   * multi-line save) coalesces into ONE sync. Fire-and-forget — the webhook
   * returns 200 right away; the pull runs ~1s later, after the ERP transaction
   * has committed.
   */
  triggerWebhookSync(): void {
    if (this.webhookTimer) return; // a sync is already scheduled within the window
    this.webhookTimer = setTimeout(() => {
      this.webhookTimer = null;
      if (this.pulling) {
        // A sync is mid-flight; reschedule so changes after it still get pulled.
        this.triggerWebhookSync();
        return;
      }
      void this.scheduledPull();
    }, 1000);
    this.webhookTimer.unref?.();
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
      await this.runEntity('category', () => this.pullCategories()),
      await this.runEntity('unit', () => this.pullUnits()),
      await this.runEntity('tobacco_profile', () => this.pullTobaccoProfiles()),
      await this.runEntity('item', () => this.pullItems()),
      await this.runEntity('customer', () => this.pullCustomers()),
      // Customer contract prices must reflect automatically (5-min poll + ERP
      // webhook), not only on a manual "Refresh from ERP" — else an ERP price
      // change never reaches the app.
      await this.runEntity('price_list', () => this.pullPriceLists()),
      await this.runEntity('customer_price', () => this.pullCustomerPrices()),
    ];
    // Reconcile cash-van stock to the ERP's current on-hand snapshot for every
    // warehouse cash-van knows — vans AND normal stores (Main Store …) — so ERP
    // stock changes affect cash-van on both the dashboard and the app.
    results.push(await this.runEntity('van/stock', () => this.pullVanStock()));
    // ERP-native customer receipts → cash-van collections (customer-scoped).
    results.push(await this.runEntity('receipts', () => this.pullReceipts()));
    return results;
  }

  /**
   * Pull the ERP's current on-hand snapshot (`GET /api/v1/van/stock`, org-wide,
   * all warehouses in one paginated call) and diff each (store, sku) against the
   * last-known quantity in `erp_stock_snapshot`. A non-zero delta is posted as a
   * generic stock-adjustment voucher (IN if it rose, OUT if it fell) — van/stock
   * has no event type, so unlike the old ledger mirror this can't distinguish a
   * SALE from a RETURN from a TRANSFER leg; it only knows the net change.
   */
  private async pullVanStock(): Promise<number> {
    const pageSize = 200;
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    let processed = 0;
    const storeByWarehouseId = new Map<string, string | null>();
    while ((page - 1) * pageSize < total) {
      const { data, total: t } = await this.erp.list<ErpVanStockRow>('van/stock', { page, pageSize });
      total = t;
      if (data.length === 0) break;
      for (const row of data) {
        if (!row.warehouseId || !row.skuCode) continue;
        let store = storeByWarehouseId.get(row.warehouseId);
        if (store === undefined) {
          const map = await this.idmap.findOne({ where: { entity: 'warehouse', erpId: row.warehouseId } });
          store = map?.localId ?? null;
          storeByWarehouseId.set(row.warehouseId, store);
        }
        if (!store) continue; // warehouse not (yet) mirrored — pullWarehouses runs first, but be safe
        await this.reconcileStockRow(store, row.skuCode, Math.round(Number(row.quantity) || 0));
        processed += 1;
      }
      if (data.length < pageSize) break;
      page += 1;
      if (page > 500) break; // safety cap
    }
    return processed;
  }

  /**
   * Diff ONE (store, sku) quantity against its last-known snapshot and, if it
   * changed, post a generic adjustment voucher for the delta — atomically with
   * advancing the baseline, so a crash mid-way never double-posts on retry (the
   * next pull just recomputes from whatever baseline actually committed).
   */
  private async reconcileStockRow(store: string, skuCode: string, quantity: number): Promise<void> {
    await this.dataSource.transaction(async (tx) => {
      const snapRepo = tx.getRepository(ErpStockSnapshot);
      const snap = await snapRepo.findOne({ where: { store, skuCode } });
      if (snap) {
        const delta = quantity - snap.quantity;
        if (delta !== 0) await this.postStockDelta(tx, store, skuCode, delta);
        snap.quantity = quantity;
        await snapRepo.save(snap);
      } else {
        // First time we've ever seen this (store, sku) — seed the baseline only.
        // Posting the full quantity as a Day-1 adjustment would just be noise.
        await snapRepo.save(snapRepo.create({ store, skuCode, quantity }));
      }
    });
  }

  /** Post a generic IN/OUT stock-adjustment voucher for a net quantity change. */
  private async postStockDelta(
    tx: EntityManager,
    store: string,
    skuCode: string,
    delta: number,
  ): Promise<void> {
    const into = delta > 0;
    const abs = Math.abs(delta);
    const kind = into ? 'IN' : 'OUT';
    const map = await this.idmap.findOne({ where: { entity: 'item', erpCode: skuCode } });
    const itemNumber = map?.localId ?? skuCode;
    const item = await this.items.findOne({ where: { itemNumber } });
    if (!item) return; // unknown item on cash-van's side — nothing to post against

    const voucherNumber = `ERP-VS-${randomUUID()}`;
    const headerRepo = tx.getRepository(VoucherHeader);
    const txnRepo = tx.getRepository(VoucherTransaction);

    await headerRepo.save(
      headerRepo.create({
        voucherNumber,
        transKind: kind,
        userCode: 'admin',
        referenceVoucherNumber: null,
        inDate: new Date(),
        total: '0',
        totalTax: '0',
        netTotal: '0',
        totalDiscountValue: '0',
        totalDiscountPercentage: '0',
        isPosted: true,
        isEdit: false,
      }),
    );
    await txnRepo.save(
      txnRepo.create({
        voucherNumber,
        itemNumber,
        itemName: item.name ?? itemNumber,
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
      }),
    );
  }

  /**
   * Full master-data refresh (the dashboard "Refresh from ERP" button): re-pull
   * EVERY company-info / catalog record from the ERP — organization, stores,
   * items (incl. old ones + price/cost), and customers. These are full pulls (no
   * cursor), so existing/old records are re-synced too. Transactions/movements
   * are NOT touched here (they're incremental via syncNow).
   */
  async refreshAll(): Promise<SyncEntityResult[]> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.enabled) {
      return [{ entity: 'all', count: 0, status: 'skipped', error: 'ERP mode is off' }];
    }
    return [
      await this.runEntity('organization', () => this.pullOrganization()),
      await this.runEntity('warehouse', () => this.pullWarehouses()),
      await this.runEntity('category', () => this.pullCategories()),
      await this.runEntity('unit', () => this.pullUnits()),
      await this.runEntity('tobacco_profile', () => this.pullTobaccoProfiles()),
      await this.runEntity('item', () => this.pullItems()),
      await this.runEntity('customer', () => this.pullCustomers()),
      await this.runEntity('price_list', () => this.pullPriceLists()),
      await this.runEntity('customer_price', () => this.pullCustomerPrices()),
    ];
  }

  /**
   * Pull ERP categories → upsert cash-van product_categories. Dedup/link via
   * id-map (entity='category'); parent links resolve through the same map (the
   * ERP returns parents first, so a child's parent is already mapped).
   */
  private async pullCategories(): Promise<number> {
    const { data } = await this.erp.list<ErpCategory>('categories', { page: 1, pageSize: 500 });
    let n = 0;
    for (const c of data) {
      if (!c.id || !c.name) continue;
      const map = await this.idmap.findOne({ where: { entity: 'category', erpId: c.id } });
      let cat = map?.localId
        ? await this.productCategories.findOne({ where: { id: map.localId } })
        : null;
      if (!cat) cat = this.productCategories.create();
      cat.nameAr = c.name;
      cat.nameEn = c.name;
      if (c.parentId) {
        const pmap = await this.idmap.findOne({ where: { entity: 'category', erpId: c.parentId } });
        cat.parentId = pmap?.localId ?? null;
      } else {
        cat.parentId = null;
      }
      await this.productCategories.save(cat);
      await this.upsertIdMap('category', c.id, c.name, cat.id);
      n += 1;
    }
    return n;
  }

  /** Pull the ERP unit master → upsert cash-van units (keyed by code == unit name). */
  private async pullUnits(): Promise<number> {
    const { data } = await this.erp.list<ErpUnit>('units', { page: 1, pageSize: 500 });
    let n = 0;
    for (const u of data) {
      const code = (u.name ?? '').trim();
      if (!code) continue;
      let unit = await this.units.findOne({ where: { code } });
      if (!unit) unit = this.units.create({ code });
      unit.nameAr = unit.nameAr || code;
      unit.nameEn = code;
      unit.baseQty = Math.max(1, Math.round(Number(u.multiplier) || 1));
      await this.units.save(unit);
      n += 1;
    }
    return n;
  }

  /**
   * Pull ERP tobacco tax profiles → upsert cash-van tobacco_tax_profiles (keyed
   * by erp_id). Money fields (per-unit fixed amounts) arrive JOD major → fils.
   * Runs BEFORE items so a synced item can link to its (already-mapped) profile.
   */
  private async pullTobaccoProfiles(): Promise<number> {
    const { data } = await this.erp.list<ErpTobaccoProfile>('tobacco-tax-profiles');
    let n = 0;
    for (const p of data) {
      let row = await this.tobaccoProfiles.findOne({ where: { erpId: p.id } });
      if (!row) row = this.tobaccoProfiles.create({ erpId: p.id });
      row.name = p.name;
      row.description = p.description ?? null;
      row.taxBase = p.taxBase as TobaccoTaxProfile['taxBase'];
      row.salesTaxEnabled = p.salesTaxEnabled;
      row.salesTaxRate = Math.round(Number(p.salesTaxRate) || 0);
      row.specialTaxEnabled = p.specialTaxEnabled;
      row.specialTaxCalculationType = p.specialTaxCalculationType as TobaccoTaxProfile['specialTaxCalculationType'];
      row.specialTaxBase = p.specialTaxBase as TobaccoTaxProfile['specialTaxBase'];
      row.specialTaxRate = p.specialTaxRate != null ? Math.round(Number(p.specialTaxRate)) : null;
      row.specialTaxFixedAmount =
        p.specialTaxFixedAmount != null ? Math.round(Number(p.specialTaxFixedAmount) * 1000) : null;
      row.withheldTaxEnabled = p.withheldTaxEnabled;
      row.withheldTaxCalculationType = p.withheldTaxCalculationType as TobaccoTaxProfile['withheldTaxCalculationType'];
      row.withheldTaxBase = p.withheldTaxBase as TobaccoTaxProfile['withheldTaxBase'];
      row.withheldTaxAmount =
        p.withheldTaxAmount != null ? Math.round(Number(p.withheldTaxAmount) * 1000) : null;
      row.withheldTaxRate = p.withheldTaxRate != null ? Math.round(Number(p.withheldTaxRate)) : null;
      row.taxIncludedInConsumerPrice = p.taxIncludedInConsumerPrice ?? false;
      row.effectiveFrom = p.effectiveFrom ?? null;
      row.effectiveTo = p.effectiveTo ?? null;
      row.isActive = p.isActive ?? true;
      const saved = await this.tobaccoProfiles.save(row);
      await this.upsertIdMap('tobacco_profile', p.id, null, saved.id);
      n += 1;
    }
    return n;
  }

  /** Pull ERP customers → upsert cash-van customers (keyed by code == customer_number). */
  private async pullCustomers(): Promise<number> {
    const pageSize = 100;
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    let processed = 0;
    while (processed < total) {
      const { data, total: t } = await this.erp.list<ErpCustomer>('customers', { page, pageSize });
      total = t;
      if (data.length === 0) break;
      for (const c of data) {
        // Anchor on the ERP customer id (stable), NOT the code — customers
        // created in the ERP UI have a NULL code, and we must still mirror them.
        const existingMap = await this.idmap.findOne({
          where: { entity: 'customer', erpId: String(c.id) },
        });
        let cust = existingMap?.localId
          ? await this.customers.findOne({ where: { customerNumber: existingMap.localId } })
          : null;
        if (!cust && c.code) {
          cust = await this.customers.findOne({ where: { customerNumber: c.code } });
        }
        // Customer number: prefer the ERP code, else keep an already-assigned
        // local number, else derive a stable one from the ERP id.
        const number =
          cust?.customerNumber ?? c.code ?? `ERP-${String(c.id).slice(0, 8)}`;
        if (!cust) cust = this.customers.create({ customerNumber: number });
        const display = c.name ?? c.code ?? number;
        cust.customerName = display;
        cust.nameAr = cust.nameAr || display; // don't clobber a curated Arabic name
        if (c.phone) cust.phone = c.phone;
        if (c.email) cust.email = c.email;
        if (c.taxNumber) cust.tin = c.taxNumber; // ERP taxNumber ↔ cash-van tin
        if (c.creditLimit != null) {
          cust.creditLimit = Number(c.creditLimit).toFixed(2); // ERP GET returns JOD major already
        }
        // AR: mirror payment terms + credit hold (see docs/SPEC-accounts-receivable.md).
        if (c.paymentTermsDays != null) cust.paymentTerms = Number(c.paymentTermsDays);
        if (c.creditHold != null) cust.creditHold = Boolean(c.creditHold);
        // ERP customer pricing assignment (drives customer_prices + the app lock).
        cust.erpPriceListId = c.priceListId ?? null;
        cust.erpPriceListName = c.priceListName ?? null;
        cust.allowManualPriceEdit = c.allowManualPriceEdit ?? true;
        await this.customers.save(cust);
        await this.upsertIdMap('customer', String(c.id), c.code ?? null, cust.customerNumber);
      }
      processed += data.length;
      page += 1;
      if (page > 200) break; // safety cap (20k customers)
    }
    // AR: mirror each customer's live open balance from the ERP onto total_debt so the
    // dashboard + van see receivables without recomputing. Best-effort — a failure here
    // must not fail the whole customer sync.
    try {
      await this.pullCustomerBalances();
    } catch (err) {
      this.logger.warn(
        `AR balance mirror skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return processed;
  }

  /**
   * Pull the ERP org-wide AR aging (`GET /api/v1/ar/aging`) and write each customer's
   * open receivable to `customers.total_debt`. Matches on the ERP customer id (via the
   * id-map) so code-less ERP customers are covered. See docs/SPEC-accounts-receivable.md.
   */
  private async pullCustomerBalances(): Promise<number> {
    const pageSize = 100;
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    let updated = 0;
    while ((page - 1) * pageSize < total) {
      const { data, total: t } = await this.erp.list<ErpAgingRow>('ar/aging', { page, pageSize });
      total = t;
      if (data.length === 0) break;
      for (const row of data) {
        const map = await this.idmap.findOne({
          where: { entity: 'customer', erpId: String(row.customerId) },
        });
        const localNumber =
          map?.localId ?? (row.customerCode ? row.customerCode : null);
        if (!localNumber) continue;
        const cust = await this.customers.findOne({
          where: { customerNumber: localNumber },
        });
        if (!cust) continue;
        cust.totalDebt = Number(row.totalOpen ?? 0).toFixed(2);
        await this.customers.save(cust);
        updated += 1;
      }
      page += 1;
      if (page > 400) break; // safety cap
    }
    return updated;
  }

  /**
   * Mirror ERP price lists (`GET /api/v1/price-lists` + `/{id}`) into local
   * `price_lists` (origin='erp', rebuilt each sync) and map each customer's ERP
   * price-list assignment → the local mirror (`customers.price_list_id`), so the
   * price-list resolution + the app apply to ERP-assigned customers. Local
   * (dashboard-authored) lists and manual assignments are left untouched.
   */
  private async pullPriceLists(): Promise<number> {
    let processed = 0;
    // 1) Pull the lists (paginated).
    const lists: ErpPriceList[] = [];
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    while (lists.length < total) {
      const { data, total: t } = await this.erp.list<ErpPriceList>('price-lists', {
        page,
        pageSize: 200,
      });
      total = t;
      if (data.length === 0) break;
      lists.push(...data);
      page += 1;
      if (page > 100) break;
    }
    const keptErpIds = new Set<string>();
    for (const l of lists) {
      keptErpIds.add(l.id);
      let local = await this.priceLists.findOne({ where: { erpId: l.id } });
      if (!local) local = this.priceLists.create({ erpId: l.id, code: l.code, origin: 'erp' });
      local.origin = 'erp';
      local.code = l.code;
      local.name = l.name ?? l.code;
      local.isActive = l.isActive ?? true;
      await this.priceLists.save(local);

      // 2) Pull its items → map skuCode→item, keep the lowest (base) tier price.
      const detail = await this.erp.getOne<ErpPriceListDetail>(`price-lists/${l.id}`);
      const byItem = new Map<string, number>();
      for (const it of detail?.items ?? []) {
        if (!it.skuCode) continue;
        const map = await this.idmap.findOne({ where: { entity: 'item', erpCode: it.skuCode } });
        const item = map?.localId
          ? await this.items.findOne({ where: { itemNumber: map.localId } })
          : null;
        if (!item) continue;
        const unitPrice = Math.round((Number(it.price) || 0) * 1000);
        const prev = byItem.get(item.id);
        if (prev === undefined || unitPrice < prev) byItem.set(item.id, unitPrice);
      }
      const keptItemIds = new Set<string>();
      for (const [itemId, unitPrice] of byItem) {
        keptItemIds.add(itemId);
        let row = await this.priceListItems.findOne({
          where: { priceListId: local.id, itemId },
        });
        if (!row) row = this.priceListItems.create({ priceListId: local.id, itemId });
        row.unitPrice = unitPrice;
        await this.priceListItems.save(row);
        processed += 1;
      }
      for (const e of await this.priceListItems.find({ where: { priceListId: local.id } })) {
        if (!keptItemIds.has(e.itemId)) await this.priceListItems.delete(e.id);
      }
    }

    // 3) Drop ERP-origin lists that no longer exist upstream (keep local ones).
    for (const l of await this.priceLists.find({ where: { origin: 'erp' } })) {
      if (l.erpId && !keptErpIds.has(l.erpId)) {
        await this.customers.update({ priceListId: l.id }, { priceListId: null });
        await this.priceListItems.delete({ priceListId: l.id });
        await this.priceLists.delete(l.id);
      }
    }

    // 4) Map each customer's ERP assignment → the local mirror. Never override a
    //    dashboard-set assignment to a LOCAL list.
    for (const c of await this.customers.find({ where: { isActive: true } })) {
      if (!c.erpPriceListId) continue;
      const local = await this.priceLists.findOne({ where: { erpId: c.erpPriceListId } });
      if (!local) continue;
      if (c.priceListId) {
        const current = await this.priceLists.findOne({ where: { id: c.priceListId } });
        if (current && current.origin === 'local') continue; // keep manual/local assignment
      }
      if (c.priceListId !== local.id) {
        c.priceListId = local.id;
        await this.customers.save(c);
      }
    }
    return processed;
  }

  /**
   * Pull each active customer's RESOLVED prices from the ERP
   * (`GET /api/v1/prices?customerCode=`) and cache the real overrides into
   * `customer_prices` (drops DEFAULT_PRICE rows). ALL active customers are queried
   * — the ERP resolver returns special contract prices even for customers with no
   * assigned price list, so we must not filter on `erp_price_list_id`. One call
   * per customer: fine at this scale; a bulk/changed-only endpoint is the scale
   * follow-up. Dashboard-authored (origin='local') rows are left untouched.
   * Assumes `pullCustomers()` ran first.
   */
  private async pullCustomerPrices(): Promise<number> {
    const custs = await this.customers.find({ where: { isActive: true } });
    let processed = 0;
    for (const cust of custs) {
      // Identify the customer to the ERP. Customers created in the ERP UI have a
      // NULL code — FlowVan shows them as `ERP-<id>` — so CODE alone can't reach
      // them. The id-map always holds the ERP customer id (`erpId`); prefer that
      // (`/prices?customerId=`). Fall back to a real code, else skip FlowVan-only
      // customers the ERP has never heard of.
      const idmap = await this.idmap.findOne({
        where: { entity: 'customer', localId: cust.customerNumber },
      });
      const idQuery: { customerId?: string; customerCode?: string } = {};
      if (idmap?.erpId) idQuery.customerId = idmap.erpId;
      else if (idmap?.erpCode) idQuery.customerCode = idmap.erpCode;
      else if (cust.customerNumber && !cust.customerNumber.startsWith('ERP-'))
        idQuery.customerCode = cust.customerNumber;
      if (!idQuery.customerId && !idQuery.customerCode) continue;
      try {
        processed += await this.syncCustomerPricesFor(cust, idQuery);
      } catch (e) {
        // One customer failing must NOT abort the whole pull. The ERP returns
        // HTTP 400 CUSTOMER_NOT_FOUND for an id/code it doesn't have — skip + continue.
        this.logger.warn(
          `customer-price pull skipped ${cust.customerNumber}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return processed;
  }

  /** Pull + cache ONE customer's resolved ERP prices. Returns rows upserted. */
  private async syncCustomerPricesFor(
    cust: Customer,
    idQuery: { customerId?: string; customerCode?: string },
  ): Promise<number> {
    let processed = 0;
    // Fetch all resolved prices for this customer (paginated).
    const rows: ErpPrice[] = [];
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    while (rows.length < total) {
      const { data, total: t } = await this.erp.list<ErpPrice>('prices', {
        ...idQuery,
        page,
        pageSize: 200,
      });
      total = t;
      if (data.length === 0) break;
      rows.push(...data);
      page += 1;
      if (page > 100) break; // safety cap
    }
    // Keep only real overrides (skip the plain SKU default).
    const overrides = rows.filter(
      (r) => r.skuCode && (r.priceSource ?? '').toUpperCase() !== 'DEFAULT_PRICE',
    );
    const keptSkus = new Set<string>();
    for (const r of overrides) {
      const sku = r.skuCode;
      keptSkus.add(sku);
      // Resolve the cash-van item + specific unit for this ERP SKU.
      const map = await this.idmap.findOne({ where: { entity: 'item', erpCode: sku } });
      const item = map?.localId
        ? await this.items.findOne({ where: { itemNumber: map.localId } })
        : null;
      let itemUnitId: string | null = null;
      if (item && r.barcode) {
        const iu = await this.itemUnits.findOne({
          where: { itemId: item.id, barcode: r.barcode },
        });
        itemUnitId = iu?.id ?? null;
      }
      let row = await this.customerPrices.findOne({
        where: { customerId: cust.id, erpSku: sku },
      });
      // A dashboard-authored (local) override is sticky — the ERP sync must
      // never overwrite it (the ERP has no API to receive it back).
      if (row && row.origin === 'local') continue;
      if (!row) row = this.customerPrices.create({ customerId: cust.id, erpSku: sku });
      row.origin = 'erp';
      row.itemId = item?.id ?? null;
      row.itemUnitId = itemUnitId;
      row.barcode = r.barcode ?? null;
      row.unitPrice = Math.round((Number(r.price) || 0) * 1000); // ERP major → fils
      row.priceSource = r.priceSource ?? null;
      row.erpPriceListId = cust.erpPriceListId ?? null;
      row.syncedAt = new Date();
      await this.customerPrices.save(row);
      processed += 1;
    }
    // Prune ERP-owned overrides that no longer apply; keep local (dashboard) ones.
    const existing = await this.customerPrices.find({ where: { customerId: cust.id } });
    for (const e of existing) {
      if (e.origin === 'local') continue;
      if (!keptSkus.has(e.erpSku)) await this.customerPrices.delete(e.id);
    }
    return processed;
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
        // Van-store payment rule: cash/cheque for a van store are created ONLY in
        // the dashboard / cash-van app — never mirrored from the ERP. Skip the
        // receipt if the customer's rep is tied to a van store.
        const rep = await this.reps.findOne({ where: { id: customer.repId } });
        const store = rep?.code
          ? await this.whs.findOne({ where: { whNumber: rep.code } })
          : null;
        if (store?.isVan) continue;
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
      wh.isVan = w.isVan ?? false; // store type mirrors the ERP warehouse
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

  /**
   * Pull the ERP catalog → upsert item_cart, grouping the unit-SKUs of each
   * product into ONE cash-van item.
   *
   * The ERP models every unit of a product as a separate SKU row (the same
   * product "سبرايت ٣٥٠ مل" has a حبة SKU and a طرد-of-30 SKU). cash-van models
   * an item once (in its base unit) plus `item_units` rows for the larger units.
   * So we page all SKUs, group by `productId`, pick the base unit as the item,
   * and mirror the other units into `item_units` — no change to the ERP.
   */
  private async pullItems(): Promise<number> {
    const pageSize = 100;
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    const all: ErpSku[] = [];
    while (all.length < total) {
      const { data, total: t } = await this.erp.list<ErpSku>('skus', { page, pageSize });
      total = t;
      if (data.length === 0) break;
      all.push(...data);
      page += 1;
      if (page > 200) break; // safety cap (20k SKUs)
    }
    // Group unit-SKUs by product. Fall back to the SKU code when productId is
    // absent (older ERP) so each SKU is still its own single-unit item.
    const byProduct = new Map<string, ErpSku[]>();
    for (const s of all) {
      if (!s.sku) continue;
      const key = s.productId || s.sku;
      const group = byProduct.get(key) ?? [];
      group.push(s);
      byProduct.set(key, group);
    }
    // ERP image URLs are relative (/uploads/…). Resolve them against the ERP
    // origin once so the stored item image is directly loadable by dashboard + app.
    const cfg = await this.settings.getErpConfig().catch(() => null);
    const erpOrigin = cfg?.baseUrl ? cfg.baseUrl.replace(/\/+$/, '') : null;
    let processed = 0;
    for (const skus of byProduct.values()) {
      await this.upsertProductItem(skus, erpOrigin);
      processed += 1;
    }
    return processed;
  }

  /** Resolve an ERP image path to an absolute URL (pass through absolute URLs). */
  private absoluteImageUrl(raw: string | null | undefined, erpOrigin: string | null): string | null {
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!erpOrigin) return null; // can't make a relative path loadable without the origin
    return `${erpOrigin}/${raw.replace(/^\/+/, '')}`;
  }

  /** Pick the base unit (multiplier 1) from a product's unit-SKUs. */
  private baseSku(skus: ErpSku[]): ErpSku {
    return (
      skus.find((s) => s.isBaseUnit) ??
      skus.find((s) => Math.round(Number(s.unitMultiplier) || 1) === 1) ??
      skus[0]
    );
  }

  /**
   * Upsert one product (all its unit-SKUs) as a single cash-van item named by
   * the PRODUCT, plus an `item_units` row per larger unit. The base unit becomes
   * the item itself; the bigger units (طرد …) are attached with their per-item
   * piece count + barcode + sale price.
   */
  private async upsertProductItem(skus: ErpSku[], erpOrigin: string | null = null): Promise<void> {
    const base = this.baseSku(skus);
    const itemNumber = base?.sku;
    if (!itemNumber) return;
    const productName = base.productName || base.label || base.sku;

    let item = await this.items.findOne({ where: { itemNumber } });
    if (!item) item = this.items.create({ itemNumber });
    item.sku = base.sku;
    item.name = productName; // the PRODUCT name, never the unit name
    item.nameAr = productName; // ERP is master → its product name is the Arabic name
    item.nameEn = productName;
    item.barcode = base.barcode || base.sku; // cash-van barcode is required + unique
    item.price = Math.round((Number(base.sellingPrice) || 0) * 1000); // major → fils
    item.cost = Math.round((Number(base.unitCost) || 0) * 1000); // major → fils
    item.isActive = base.isActive ?? true;
    item.imageUrl = this.absoluteImageUrl(base.imageUrl, erpOrigin);

    // Tobacco tax: the ERP /skus already resolves SKU→product inheritance. Map
    // the ERP profile id → our local profile id (synced just before items), and
    // store the consumer price in fils per base piece.
    item.isTobaccoProduct = base.isTobaccoProduct ?? false;
    if (item.isTobaccoProduct) {
      const localProfile = base.tobaccoTaxProfileId
        ? await this.tobaccoProfiles.findOne({ where: { erpId: base.tobaccoTaxProfileId } })
        : null;
      item.tobaccoTaxProfileId = localProfile?.id ?? null;
      item.consumerPriceFils =
        base.consumerPrice != null ? Math.round(Number(base.consumerPrice) * 1000) : null;
    } else {
      item.tobaccoTaxProfileId = null;
      item.consumerPriceFils = null;
    }

    item = await this.items.save(item);

    // Map every unit-SKU (base + larger) to this item, so movements/sales that
    // reference any unit's SKU resolve back to the same cash-van item.
    for (const s of skus) {
      await this.upsertIdMap('item', String(s.id), s.sku, itemNumber);
    }

    // Mirror the larger units (multiplier > 1) into item_units.
    for (const s of skus) {
      if (s === base) continue;
      const mult = Math.max(1, Math.round(Number(s.unitMultiplier) || 1));
      const unitName = (s.unitLabel || s.label || '').trim();
      if (!unitName || mult <= 1) continue; // base / unnamed units have no extra row
      // A larger-unit SKU that previously came through as its own item_cart row
      // (before grouping) is now an item_unit — drop the stale item if present.
      if (s.sku !== itemNumber) {
        await this.items.delete({ itemNumber: s.sku }).catch(() => undefined);
      }
      const unit = await this.ensureUnit(unitName, mult);
      let iu = await this.itemUnits.findOne({
        where: { itemId: item.id, unitId: unit.id },
      });
      if (!iu) iu = this.itemUnits.create({ itemId: item.id, unitId: unit.id });
      iu.barcode = s.barcode || s.sku; // item_units.barcode is required + unique
      iu.qty = mult;
      iu.salePrice = (Number(s.sellingPrice) || 0).toFixed(2); // JOD major
      await this.itemUnits.save(iu);
    }
  }

  /** Find-or-create a unit master row keyed by its name (e.g. طرد). */
  private async ensureUnit(name: string, baseQty: number): Promise<Unit> {
    let unit = await this.units.findOne({ where: { code: name } });
    if (!unit) unit = this.units.create({ code: name });
    unit.nameAr = unit.nameAr || name;
    unit.nameEn = name;
    unit.baseQty = Math.max(1, Math.round(baseQty));
    return this.units.save(unit);
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
