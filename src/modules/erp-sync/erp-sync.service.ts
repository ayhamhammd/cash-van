import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

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
import { ErpOutbox } from './entities/erp-outbox.entity';
import { ErpIdMap } from './entities/erp-id-map.entity';
import { ErpSyncCursor } from './entities/erp-sync-cursor.entity';
import { ErpOutboxKind } from './entities/erp-outbox.entity';

/** cash-van voucher kind → ERP outbox kind (per-kind outbound, same kind preserved). */
// Read from process.env for the same reason as ERP_OUTBOX_DRAIN_MS: @Interval()
// runs at class-definition time, before DI. Validated in validation.schema.ts.
const PULL_INTERVAL_MS = parseInt(process.env.ERP_PULL_INTERVAL_MS ?? '300000', 10);

const OUTBOX_KIND_BY_TRANS: Record<string, ErpOutboxKind | undefined> = {
  SALE: 'SALE_INVOICE',
  RETURN: 'SALES_RETURN',
  ORDER: 'SALES_ORDER',
  IN: 'STOCK_ADJUSTMENT',
  OUT: 'STOCK_ADJUSTMENT',
  TRANSFER: 'STOCK_TRANSFER',
};

/** ERP `GET customers/by-code/{code}/balance` — figures in major units. */
export interface ErpBalance {
  customerId: string;
  customerCode: string;
  customerName: string;
  balance: number;
  creditLimit: number;
}

/** One posting line of an ERP customer statement (major units). */
export interface ErpStatementLine {
  date: string | null;
  type: 'INVOICE' | 'PAYMENT';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

/** ERP `GET customers/by-code/{code}/statement` — ledger with running balance. */
export interface ErpStatement {
  customerId: string;
  customerCode: string;
  customerName: string;
  creditLimit: number;
  from: string | null;
  to: string | null;
  openingBalance: number;
  closingBalance: number;
  lines: ErpStatementLine[];
}

/** ERP `GET accounts/by-code/{code}/balance` — one GL account, major units. */
export interface ErpAccountBalance {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  balance: number;
  totalDebit: number;
  totalCredit: number;
}

/**
 * A live balance handed to a controller. `source` distinguishes a real ERP
 * figure from a gap so the UI never shows a stale/guessed number as if it were
 * the ERP's — `unavailable` carries a `reason` (unlinked | erp_off | fetch_failed).
 */
export interface ErpLiveBalance {
  source: 'erp' | 'unavailable';
  reason: string | null;
  balance: number | null;
  creditLimit?: number;
  accountCode?: string;
  accountName?: string;
}

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
  // Tax exemption, mirrored onto our customer and frozen onto their vouchers.
  isTaxExempt?: boolean | null;
  taxExemptionType?: string | null;      // FULL_EXEMPTION | VAT_EXEMPTION | SPECIAL_APPROVAL
  taxExemptionNumber?: string | null;
  taxExemptionReason?: string | null;
  taxExemptionValidFrom?: string | null; // ISO
  taxExemptionValidTo?: string | null;   // ISO
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

/**
 * Where one ERP SKU's stock lands in cash-van: an item, and a POOL inside it.
 *
 * The ERP keys stock by `(sku_id, warehouse_id)`; cash-van keys it by
 * `(item_number, stock_unit_code, store_number)`. This is the translation
 * between them (docs/SPEC-per-unit-stock.md §5.1).
 */
interface StockTarget {
  itemNumber: string;
  /** The `item_units` row the SKU is, or null when it IS the base item. */
  itemUnitId: string | null;
  /** '' = the item's base pool; anything else is a variant's own pool. */
  stockUnitCode: string;
  /** Pieces per unit of the resolved unit (1 for the base SKU and every variant). */
  unitBaseQty: number;
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
    private readonly vouchers: VouchersService,
    private readonly outbox: ErpOutboxService,
    @InjectRepository(ErpOutbox) private readonly outboxRepo: Repository<ErpOutbox>,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * The item numbers a van store is ALLOWED to hold, per the ERP's per-warehouse
   * allowlist (`sku_warehouses`, exposed at `/api/v1/inventory/allowed-items`).
   * Used to filter a salesman's stock-request picker down to items connected to
   * his own store.
   *
   * Returns an EMPTY set when the ERP is disabled or the van is not mapped to an
   * ERP warehouse — the caller decides what empty means (typically "no allowlist
   * configured → do not restrict", so a mis-config never hides every item). The
   * allowlist is intentionally independent of on-hand quantity: a van may request
   * an item precisely because it holds none yet.
   */
  async allowedItemNumbersForWarehouse(whNumber: string): Promise<Set<string>> {
    if (!whNumber) return new Set();
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled) return new Set();

    const whMap = await this.idmap.findOne({
      where: { entity: 'warehouse', localId: whNumber },
    });
    if (!whMap?.erpId) return new Set();

    // Page through the allowlist (the endpoint caps pageSize at 100).
    const skus: Array<{ skuId: string; skuCode: string }> = [];
    const pageSize = 100;
    for (let page = 1; page <= 200; page++) {
      const res = await this.erp.list<{ skuId: string; skuCode: string }>(
        'inventory/allowed-items',
        { warehouseId: whMap.erpId, page, pageSize },
      );
      skus.push(...res.data);
      if (res.data.length < pageSize) break;
    }
    if (skus.length === 0) return new Set();

    // Map ERP sku uuid → cash-van itemNumber through the id map (authoritative);
    // fall back to the ERP sku code, which matches by the sync convention.
    const erpSkuIds = skus.map((s) => s.skuId).filter(Boolean);
    const maps = erpSkuIds.length
      ? await this.idmap.find({ where: { entity: 'item', erpId: In(erpSkuIds) } })
      : [];
    const byErpId = new Map(maps.map((m) => [m.erpId, m.localId]));

    const out = new Set<string>();
    for (const s of skus) {
      const itemNumber = byErpId.get(s.skuId) ?? s.skuCode;
      if (itemNumber) out.add(itemNumber);
    }
    return out;
  }

  /**
   * The item numbers a SALESMAN may see and handle — across sale, stock request,
   * return, order and item reports — being his VAN store's ERP allowlist
   * (sku_warehouses), mirroring how items are linked to a store on the ERP.
   *
   * Returns an EMPTY set when the caller is not a salesman, has no van assigned, or
   * the van is not linked / the ERP is off. Callers MUST treat empty as "no
   * restriction — show everything", so a manager/admin (no van) sees the full
   * catalogue and a mis-configured van never has its whole catalogue hidden.
   */
  async allowedItemNumbersForUser(userSub: string): Promise<Set<string>> {
    if (!userSub) return new Set();
    const rep = await this.reps.findOne({ where: { userId: userSub } });
    if (!rep?.vanId) return new Set();
    const van = await this.whs.findOne({ where: { id: rep.vanId } });
    if (!van?.whNumber) return new Set();
    return this.allowedItemNumbersForWarehouse(van.whNumber);
  }

  /** Queue a posted cash-van voucher for push to the ERP, by kind. */
  @OnEvent('erp.voucher.posted')
  async onVoucherPosted(p: { voucherNumber: string; transKind: string }): Promise<void> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled) return;
    // Always auto-push (owner decision). `directExport` used to park the voucher
    // in the ERP Export page instead; a voucher that posted but never reached the
    // ERP is invisible until someone remembers to drain that queue, so the push is
    // now unconditional. The Export page still works for re-sending by hand, and
    // the outbox stays idempotent on externalId, so a manual re-send can't
    // duplicate an invoice the auto-push already created.
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
   * Seed every stock-movement cursor to "now" so the next pull skips all history.
   * Run this ONCE right after switching the ERP API key to a dedicated integration
   * user: without it, the first pull (cursor still null → full pull) would re-mirror
   * past movements — including cash-van's own pushes that were recorded under the
   * OLD admin key — and double-count stock. Future movements sync normally. Admin only.
   */
  async catchUpMovements(): Promise<{ seeded: string[]; at: string }> {
    const now = new Date();
    const entities = new Set(
      (await this.allStoreCodes()).map((s) => `movements:${s}`),
    );
    // Include any existing movements:* cursors too (e.g. stale/old store codes).
    for (const c of await this.cursors.find()) {
      if (c.entity.startsWith('movements:')) entities.add(c.entity);
    }
    for (const entity of entities) {
      const c =
        (await this.cursors.findOne({ where: { entity } })) ??
        this.cursors.create({ entity });
      c.updatedSince = now;
      c.lastError = null;
      await this.cursors.save(c);
    }
    return { seeded: [...entities], at: now.toISOString() };
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

  // ── Live reads from the ERP (money & credit, straight from source) ──────────
  // The ERP is the book of record for balances; these fetch it live rather than
  // recomputing from mirrored data. All return null when the ERP is off or the
  // key/code isn't linked, so callers degrade to "unavailable" cleanly.

  /** True when the ERP integration is enabled and fully configured. */
  private async erpConfigReady(): Promise<boolean> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    return !!(cfg?.enabled && cfg.baseUrl && cfg.apiKey);
  }

  /** A customer's live balance from the ERP, keyed by ERP customer code. */
  async getErpCustomerBalance(code: string): Promise<ErpBalance | null> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey || !code) return null;
    return this.erp.getOne<ErpBalance>(
      `customers/by-code/${encodeURIComponent(code)}/balance`,
    );
  }

  /** A customer's live account statement from the ERP (invoices + receipts, running balance). */
  async getErpCustomerStatement(
    code: string,
    range: { from?: string; to?: string } = {},
  ): Promise<ErpStatement | null> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey || !code) return null;
    const qs = new URLSearchParams();
    if (range.from) qs.set('from', range.from);
    if (range.to) qs.set('to', range.to);
    const suffix = qs.toString() ? `?${qs}` : '';
    return this.erp.getOne<ErpStatement>(
      `customers/by-code/${encodeURIComponent(code)}/statement${suffix}`,
    );
  }

  /** A GL account's live balance from the ERP, keyed by chart-of-accounts code. */
  async getErpAccountBalance(code: string): Promise<ErpAccountBalance | null> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey || !code) return null;
    return this.erp.getOne<ErpAccountBalance>(
      `accounts/by-code/${encodeURIComponent(code)}/balance`,
    );
  }

  // ── Id-resolving wrappers (what controllers call) ───────────────────────────
  // Each returns a small envelope with `source: 'erp' | 'unavailable'` so the UI
  // can label a live figure vs. a gap (ERP off, not linked, or fetch failed)
  // without inferring it from a null.

  /** Live ERP balance for a cash-van customer id (resolves the ERP code). */
  async customerErpBalanceById(customerId: string): Promise<ErpLiveBalance> {
    const customer = await this.customers.findOne({
      where: { id: customerId },
      select: { id: true, customerNumber: true },
    });
    if (!customer?.customerNumber) {
      return { source: 'unavailable', reason: 'unlinked', balance: null };
    }
    if (!(await this.erpConfigReady())) {
      return { source: 'unavailable', reason: 'erp_off', balance: null };
    }
    try {
      const erp = await this.getErpCustomerBalance(customer.customerNumber);
      if (!erp) return { source: 'unavailable', reason: 'not_found', balance: null };
      return { source: 'erp', reason: null, balance: erp.balance, creditLimit: erp.creditLimit };
    } catch {
      return { source: 'unavailable', reason: 'fetch_failed', balance: null };
    }
  }

  /** Live ERP statement for a cash-van customer id (resolves the ERP code). */
  async customerErpStatementById(
    customerId: string,
    range: { from?: string; to?: string } = {},
  ): Promise<ErpStatement | { source: 'unavailable'; reason: string }> {
    const customer = await this.customers.findOne({
      where: { id: customerId },
      select: { id: true, customerNumber: true },
    });
    if (!customer?.customerNumber) return { source: 'unavailable', reason: 'unlinked' };
    if (!(await this.erpConfigReady())) return { source: 'unavailable', reason: 'erp_off' };
    try {
      const erp = await this.getErpCustomerStatement(customer.customerNumber, range);
      if (!erp) return { source: 'unavailable', reason: 'not_found' };
      return erp;
    } catch {
      return { source: 'unavailable', reason: 'fetch_failed' };
    }
  }

  /** Live ERP balance for a rep id — the rep's linked "cash with salesman" GL account. */
  async repErpBalanceById(repId: string): Promise<ErpLiveBalance> {
    const rep = await this.reps.findOne({
      where: { id: repId },
      select: { id: true, erpAccountCode: true },
    });
    if (!rep?.erpAccountCode) return { source: 'unavailable', reason: 'unlinked', balance: null };
    if (!(await this.erpConfigReady())) {
      return { source: 'unavailable', reason: 'erp_off', balance: null };
    }
    try {
      const erp = await this.getErpAccountBalance(rep.erpAccountCode);
      if (!erp) return { source: 'unavailable', reason: 'not_found', balance: null };
      return {
        source: 'erp', reason: null, balance: erp.balance,
        accountCode: erp.accountCode, accountName: erp.accountName,
      };
    } catch {
      return { source: 'unavailable', reason: 'fetch_failed', balance: null };
    }
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
    // Always auto-push — see onVoucherPosted.
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
    /**
     * Customers created in the van or the dashboard that have not reached the
     * ERP — queued because it was unreachable or rejected them. Surfaced here so
     * an unexported customer is visible instead of silently missing.
     */
    customers: Array<{
      customerNumber: string;
      name: string;
      status: string;
      attempts: number;
      error: string | null;
    }>;
  }> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled) return { vouchers: [], collections: [], customers: [] };

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

    // Customers that never reached the ERP. Unlike vouchers and collections —
    // which are found by their ABSENCE from the outbox — a customer is queued at
    // the moment the push fails, so the pending ones are the outbox rows that
    // have not posted yet.
    const pendingCustomers = await this.outboxRepo.find({
      where: [
        { kind: 'CUSTOMER', status: 'pending' },
        { kind: 'CUSTOMER', status: 'failed' },
        { kind: 'CUSTOMER', status: 'dead_letter' },
      ],
      order: { createdAt: 'DESC' },
      take: 500,
    });
    const customerNameByNumber = new Map(
      (
        await this.customers.find({
          where: { customerNumber: In(pendingCustomers.map((r) => r.ref)) },
        })
      ).map((c) => [c.customerNumber, c.nameAr || c.customerName || c.customerNumber]),
    );

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
      customers: pendingCustomers.map((r) => ({
        customerNumber: r.ref,
        name: customerNameByNumber.get(r.ref) ?? r.ref,
        status: r.status,
        attempts: r.attempts,
        error: r.error ?? null,
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
  async exportAllPending(): Promise<{
    vouchers: number;
    collections: number;
    customers: number;
  }> {
    const pending = await this.listPendingExports();
    for (const v of pending.vouchers) {
      const kind = OUTBOX_KIND_BY_TRANS[v.transKind];
      if (kind) await this.outbox.enqueue(kind, v.voucherNumber);
    }
    for (const c of pending.collections) {
      await this.outbox.enqueue('PAYMENT', c.id);
    }
    // Customers are ALREADY queued — pushCustomer enqueues them the moment the
    // ERP refuses or is unreachable. They need draining, not re-enqueuing. Run
    // it here so the dashboard button exports them now instead of leaving the
    // user to wait for the next scheduled drain.
    await this.outbox.drain().catch(() => undefined);
    return {
      vouchers: pending.vouchers.length,
      collections: pending.collections.length,
      customers: pending.customers.length,
    };
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
        // Rejected (validation, auth, 5xx) — queue it. The push used to stop
        // here with a log line nobody reads, and the customer was never exported.
        this.logger.warn(`pushCustomer ${code} rejected, queued: ${res.error}`);
        await this.outbox.enqueue('CUSTOMER', code);
      }
    } catch (e) {
      // The ERP is unreachable — the case this exists for. The customer is
      // already saved locally; queue the export so it leaves as soon as the ERP
      // is back, either on the next drain or from the dashboard's Export button.
      this.logger.warn(
        `pushCustomer ${code} failed, queued: ${e instanceof Error ? e.message : e}`,
      );
      await this.outbox.enqueue('CUSTOMER', code);
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
  @Interval(PULL_INTERVAL_MS)
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
    // Mirror ERP stock movements for EVERY warehouse cash-van knows — vans AND
    // normal stores (Main Store …) — so ERP IN/OUT/TRANSFER affect cash-van
    // stock on both the dashboard and the app. Each ERP transfer is two ledger
    // rows (OUT of source, IN to dest); iterating all warehouses mirrors both
    // legs, moving stock between the two cash-van stores.
    results.push(...(await this.pullAllMovements()));
    // ERP-native customer receipts → cash-van collections (customer-scoped).
    results.push(await this.runEntity('receipts', () => this.pullReceipts()));
    return results;
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
        // Tax exemption. Written on every pull, not just on insert — the whole
        // point is that granting or revoking it in the ERP reaches the van and
        // the phone on the next sync. Assigned unconditionally (not `if (x)`)
        // so REVOKING an exemption actually clears it here.
        cust.isTaxExempt = Boolean(c.isTaxExempt);
        cust.taxExemptionType = c.taxExemptionType ?? null;
        cust.taxExemptionNumber = c.taxExemptionNumber ?? null;
        cust.taxExemptionReason = c.taxExemptionReason ?? null;
        cust.taxExemptionValidFrom = c.taxExemptionValidFrom
          ? new Date(c.taxExemptionValidFrom)
          : null;
        cust.taxExemptionValidTo = c.taxExemptionValidTo
          ? new Date(c.taxExemptionValidTo)
          : null;
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
    // An ERP pull can touch any rep's customers, and the batch does not track
    // which. Signal with no repId so every van re-pulls, rather than guessing
    // and leaving one holding stale credit limits or prices.
    if (processed > 0) {
      this.events.emit('customer.changed', { reason: 'erp.customers.pulled' });
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

  /** Every warehouse + van-store code cash-van knows (dedup'd). */
  private async allStoreCodes(): Promise<string[]> {
    const [whs, reps] = await Promise.all([
      this.whs.find({ select: { whNumber: true } }),
      this.reps.find({ select: { code: true } }),
    ]);
    return [
      ...new Set(
        [...whs.map((w) => w.whNumber), ...reps.map((r) => r.code)].filter(
          (c): c is string => !!c,
        ),
      ),
    ];
  }

  /**
   * Mirror the ERP stock-movement ledger for every store into cash-van (the
   * per-store cursor + `movement` id-map make it idempotent). Runs inside
   * `syncNow` (5-min).
   */
  async pullAllMovements(): Promise<SyncEntityResult[]> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.enabled) return [];
    const results: SyncEntityResult[] = [];
    for (const store of await this.allStoreCodes()) {
      results.push(
        await this.runEntity(`movements:${store}`, () => this.pullMovementsForStore(store)),
      );
    }
    // If any ERP movement landed (an ERP transfer/adjustment to a van, pulled via
    // the webhook fast-path), tell the vans to refresh their stock in real time.
    // The mirror inserts vouchers directly, so it does NOT emit erp.voucher.posted
    // — this is the signal for the ERP-driven path. No rep is named (an ERP change
    // can touch any van), so it fans out to all; each pulls a small ledger and the
    // unaffected no-op. Emitted ONCE per sync, so a bulk catch-up does not spam.
    const applied = results.reduce((n, r) => n + (r.count || 0), 0);
    if (applied > 0) {
      this.events.emit('stock.changed', { reason: 'erp.movements.pulled' });
    }
    return results;
  }

  /**
   * Inbound mirror (ERP → cash-van) for ONE warehouse (van or normal). Pulls the
   * ERP stock-movement ledger since the per-store cursor and creates a REAL,
   * stock-affecting cash-van voucher of the SAME kind for each movement (SALE,
   * RETURN, TRANSFER, IN, OUT). The ERP feed already excludes cash-van's own
   * pushes (made by the integration user), so this never echoes our outbound
   * documents; the `ERP-MV-` prefix + a 'movement' id-map row also dedup and
   * stop the posted-event handler from pushing them back.
   */
  private async pullMovementsForStore(store: string): Promise<number> {
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
        try {
          await this.mirrorMovement(mv, store);
          n += 1;
        } catch (err) {
          // One unmirrorable movement must NOT stop the other 65. Before this,
          // a single bad row aborted the store's batch, the cursor never
          // advanced, and every later sync retried the same row and failed the
          // same way — so no stock EVER reached cash-van. Log it, skip it, and
          // let the rest through. The usual cause is a movement whose SKU has
          // no matching item_cart row, which is a catalogue problem the sync
          // cannot fix by retrying.
          this.logger.warn(
            `Skipped ERP movement ${mv.id} (${mv.skuCode ?? 'no sku'}) for store ` +
              `${store}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
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

  /**
   * ERP SKU code → the cash-van POOL its stock belongs to.
   *
   * The variant's own unit comes first: `item_units.erp_sku_code` (written by
   * upsertProductItem) is the only thing that can tell أحمر from أزرق. Both
   * resolve to the same item through every other route, and dropping them into
   * the same pool is precisely the bug this spec exists to fix.
   *
   * Then the direct hit — the SKU that became the item itself — and finally the
   * id-map, which carries a row per unit-SKU pointing at the grouped item. That
   * last one is the fallback for a SKU whose unit has not been re-synced yet: it
   * lands in the base pool, which is exactly today's behaviour.
   */
  /**
   * READ-ONLY stock drift detector — the safe first step of the ERP sync rework
   * (docs/PLAN-erp-sync-reconciliation.md §7).
   *
   * Pulls the ERP's absolute snapshot (GET /van/stock, the source of truth) and
   * compares it, per (store, item, pool), against cash-van's computed on-hand
   * (the item_balance view). Reports where the two disagree and by how much.
   *
   * It writes NOTHING. Its only jobs are to quantify the drift you can see in the
   * field, and to exercise /van/stock at a realistic page cadence so we know the
   * rate-limit behaviour BEFORE any reconciliation is built against it — the exact
   * thing that sank the previous snapshot attempt (migration DropErpStockSnapshot).
   *
   * Unit basis: /van/stock.quantity and the movement feed's quantityChanged are
   * BOTH base units, and the mirror stores base pieces into item_balance, so the
   * comparison is direct — no unit conversion, which is where false drift hides.
   * The resolver is the SAME one the mirror uses, so the mapping matches reality.
   */
  async computeStockDrift(): Promise<{
    checkedAt: string;
    erpRowsFetched: number;
    poolsCompared: number;
    driftedPools: number;
    absTotalDrift: number;
    /** ERP skus that map to no local item — a mapping gap, not a quantity gap. */
    unresolvedSkus: number;
    /** ERP warehouse names with no cash-van store of that name. */
    unmatchedWarehouses: string[];
    rows: Array<{
      storeNumber: string;
      storeName: string;
      itemNumber: string;
      itemName: string | null;
      stockUnitCode: string;
      erpQty: number;
      localQty: number;
      delta: number;
    }>;
  }> {
    // 1. Map ERP warehouse NAME → cash-van store number. /van/stock returns a
    //    name, not the code; cash-van pulled these warehouses from the ERP, so
    //    the names line up. Unmatched names are surfaced, never silently dropped.
    const stores = await this.whs.find();
    const storeByName = new Map<string, { number: string; name: string }>();
    for (const w of stores) {
      if (w.whName) storeByName.set(w.whName.trim(), { number: w.whNumber, name: w.whName });
    }

    // 2. Pull the whole ERP snapshot, page by page.
    type VanStockRow = {
      skuCode: string;
      warehouseName: string;
      quantity: number;
    };
    const erpByPool = new Map<string, number>(); // key: store|item|unit → base qty
    let erpRowsFetched = 0;
    let unresolvedSkus = 0;
    const unmatchedWarehouses = new Set<string>();
    const pageSize = 200;
    let page = 1;
    for (;;) {
      let data: VanStockRow[];
      let total: number;
      try {
        ({ data, total } = await this.erp.list<VanStockRow>('van/stock', {
          page,
          pageSize,
        }));
      } catch (e) {
        // Unreachable/misconfigured ERP, or /van/stock not exposed — a clear
        // operator message beats a raw 500. This is read-only, so nothing is
        // half-done to unwind.
        throw new ServiceUnavailableException(
          `Could not read the ERP stock snapshot (GET /van/stock): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      for (const r of data) {
        erpRowsFetched += 1;
        const store = r.warehouseName ? storeByName.get(r.warehouseName.trim()) : undefined;
        if (!store) {
          if (r.warehouseName) unmatchedWarehouses.add(r.warehouseName);
          continue;
        }
        const target = await this.resolveStockTarget(r.skuCode);
        if (!target) {
          unresolvedSkus += 1;
          continue;
        }
        const key = `${store.number}|${target.itemNumber}|${target.stockUnitCode}`;
        erpByPool.set(key, (erpByPool.get(key) ?? 0) + (Number(r.quantity) || 0));
      }
      if (page * pageSize >= total || data.length === 0) break;
      page += 1;
      if (page > 500) break; // safety cap (100k rows)
    }

    // 3. cash-van's computed on-hand per pool, from the item_balance view.
    const localRows: Array<{
      stock_number: string;
      item_number: string;
      item_name: string | null;
      stock_unit_code: string;
      qty: string;
    }> = await this.dataSource.query(
      `SELECT stock_number, item_number, MAX(item_name) AS item_name,
              stock_unit_code, SUM(qty)::numeric(14,3) AS qty
         FROM item_balance
        GROUP BY stock_number, item_number, stock_unit_code`,
    );
    const localByPool = new Map<string, { qty: number; itemName: string | null }>();
    for (const r of localRows) {
      localByPool.set(`${r.stock_number}|${r.item_number}|${r.stock_unit_code}`, {
        qty: Number(r.qty) || 0,
        itemName: r.item_name,
      });
    }
    const storeName = new Map<string, string>();
    for (const w of stores) storeName.set(w.whNumber, w.whName);

    // 4. Compare every pool present on EITHER side. A pool the ERP has and
    //    cash-van does not (localQty 0) is drift too, and vice-versa.
    const keys = new Set<string>([...erpByPool.keys(), ...localByPool.keys()]);
    const rows: Array<{
      storeNumber: string;
      storeName: string;
      itemNumber: string;
      itemName: string | null;
      stockUnitCode: string;
      erpQty: number;
      localQty: number;
      delta: number;
    }> = [];
    let absTotalDrift = 0;
    for (const key of keys) {
      const [storeNumber, itemNumber, stockUnitCode] = key.split('|');
      // Only compare pools whose store we actually mapped to the ERP snapshot —
      // a store the ERP key cannot see would otherwise read as "all local, no ERP".
      if (!erpByPool.has(key) && !storeByName.has(storeName.get(storeNumber) ?? '')) {
        continue;
      }
      const erpQty = erpByPool.get(key) ?? 0;
      const local = localByPool.get(key);
      const localQty = local?.qty ?? 0;
      const delta = Math.round((erpQty - localQty) * 1000) / 1000;
      if (delta === 0) continue;
      absTotalDrift += Math.abs(delta);
      rows.push({
        storeNumber,
        storeName: storeName.get(storeNumber) ?? storeNumber,
        itemNumber,
        itemName: local?.itemName ?? null,
        stockUnitCode,
        erpQty,
        localQty,
        delta,
      });
    }
    rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    return {
      checkedAt: new Date().toISOString(),
      erpRowsFetched,
      poolsCompared: keys.size,
      driftedPools: rows.length,
      absTotalDrift: Math.round(absTotalDrift * 1000) / 1000,
      unresolvedSkus,
      unmatchedWarehouses: [...unmatchedWarehouses],
      rows,
    };
  }

  /**
   * Live on-hand quantities read straight from the ERP's absolute snapshot
   * (GET /van/stock — the book of record), NOT from cash-van's summed-delta
   * item_balance view. Same pool shape as item_balance so the UI can swap the
   * source: one row per (store, item, stock unit) with the ERP's quantity.
   *
   * Targeted mode (itemNumbers given) resolves those items' ERP sku codes and
   * pulls only their rows — one cheap call per sku, no full-catalogue scan.
   * Broad mode (no itemNumbers) paginates the whole snapshot. `stockNumber`
   * narrows to one store. Returns a { source, reason, asOf } envelope so callers
   * can label a live figure vs. a gap without inferring it from an empty list.
   */
  /**
   * Live ERP on-hand as a lookup for OVERLAYING onto locally-computed balance
   * rows, so an ERP in/out/transfer reflects on the dashboard immediately rather
   * than waiting for the summed-delta `item_balance` view to catch up. Key is
   * `${stockNumber}|${itemNumber}|${stockUnitCode}` — the same pool shape the
   * views use.
   *
   * `live` is false when the ERP is off or unreachable, in which case callers keep
   * their local qty (a dashboard must never break on an ERP outage). A key that is
   * PRESENT carries the ERP's authoritative number. A key that is ABSENT while
   * `live` is true is intentionally left to the caller: the ERP feed omits zero
   * pools, and an unmapped item must not be misread as zero — so the safe default
   * at every call site is "keep the local value on a miss".
   */
  async liveErpQtyIndex(opts: {
    itemNumbers?: string[];
    stockNumber?: string;
  }): Promise<{ live: boolean; asOf: string | null; qty: Map<string, number> }> {
    const res = await this.liveErpStock(opts);
    const qty = new Map<string, number>();
    for (const r of res.rows) {
      qty.set(`${r.stockNumber}|${r.itemNumber}|${r.stockUnitCode}`, r.quantity);
    }
    return { live: res.source === 'erp', asOf: res.asOf, qty };
  }

  /**
   * Store numbers that are salesmen's vans (`rep.van_id → warehouse`). A van's
   * on-hand must stay on the LOCAL ledger, which drops the instant the salesman
   * sells; overlaying live ERP there would lag his own un-synced sales and risk
   * overselling. Warehouse/main-store on-hand has no such issue — the ERP owns it.
   */
  async vanStoreNumbers(): Promise<Set<string>> {
    const rows: Array<{ n: string }> = await this.dataSource.query(
      `SELECT DISTINCT w.wh_number AS n
         FROM warehouses w
         JOIN reps r ON r.van_id = w.id
        WHERE r.van_id IS NOT NULL AND w.wh_number IS NOT NULL`,
    );
    return new Set(rows.map((r) => r.n));
  }

  async liveErpStock(opts: {
    itemNumbers?: string[];
    stockNumber?: string;
  }): Promise<{
    source: 'erp' | 'unavailable';
    reason: string | null;
    asOf: string | null;
    rows: Array<{
      stockNumber: string;
      storeName: string;
      itemNumber: string;
      stockUnitCode: string;
      quantity: number;
    }>;
  }> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey) {
      return { source: 'unavailable', reason: 'erp_off', asOf: null, rows: [] };
    }

    // ERP warehouse NAME → cash-van store. /van/stock returns the name, not the
    // code; cash-van pulled these warehouses from the ERP, so the names line up.
    const stores = await this.whs.find();
    const storeByName = new Map<string, { number: string; name: string }>();
    for (const w of stores) {
      if (w.whName) storeByName.set(w.whName.trim(), { number: w.whNumber, name: w.whName });
    }

    type VanStockRow = { skuCode: string; warehouseName: string; quantity: number };
    const erpRows: VanStockRow[] = [];
    try {
      const items = opts.itemNumbers?.filter(Boolean) ?? [];
      if (items.length) {
        // Targeted: resolve the items' ERP sku codes, pull just those.
        const units = await this.itemUnits.find({
          where: { item: { itemNumber: In(items) } },
          relations: { item: true },
        });
        const mappedCodes = units.map((u) => u.erpSkuCode).filter(Boolean) as string[];
        // Items with NO mapped erp_sku_code fall back to their own number as the
        // candidate sku code — the ERP sku code is usually the barcode/number, and
        // item_units.erp_sku_code is not always populated. Without this, a targeted
        // lookup for an unmapped item returned nothing and read as "0 available"
        // (the "المتوفر 0" bug on the approval page and availability views).
        const itemsWithMapping = new Set(
          units
            .filter((u) => u.erpSkuCode)
            .map((u) => u.item?.itemNumber)
            .filter(Boolean) as string[],
        );
        const fallbackCodes = items.filter((n) => !itemsWithMapping.has(n));
        const codes = [...new Set([...mappedCodes, ...fallbackCodes])] as string[];
        for (const code of codes) {
          const { data } = await this.erp.list<VanStockRow>('van/stock', {
            skuCode: code,
            page: 1,
            pageSize: 200,
          });
          erpRows.push(...data);
        }
      } else {
        // Broad: the whole snapshot, page by page.
        const pageSize = 200;
        let page = 1;
        for (;;) {
          const { data, total } = await this.erp.list<VanStockRow>('van/stock', { page, pageSize });
          erpRows.push(...data);
          if (page * pageSize >= total || data.length === 0) break;
          page += 1;
          if (page > 500) break;
        }
      }
    } catch {
      return { source: 'unavailable', reason: 'fetch_failed', asOf: null, rows: [] };
    }

    // Aggregate ERP rows into cash-van pools (store | item | stock unit).
    const byPool = new Map<string, { store: { number: string; name: string }; itemNumber: string; stockUnitCode: string; qty: number }>();
    for (const r of erpRows) {
      const store = r.warehouseName ? storeByName.get(r.warehouseName.trim()) : undefined;
      if (!store) continue;
      if (opts.stockNumber && store.number !== opts.stockNumber) continue;
      const target = await this.resolveStockTarget(r.skuCode);
      if (!target) continue;
      const key = `${store.number}|${target.itemNumber}|${target.stockUnitCode}`;
      const cur = byPool.get(key);
      if (cur) cur.qty += Number(r.quantity) || 0;
      else byPool.set(key, {
        store,
        itemNumber: target.itemNumber,
        stockUnitCode: target.stockUnitCode,
        qty: Number(r.quantity) || 0,
      });
    }

    const rows = [...byPool.values()].map((p) => ({
      stockNumber: p.store.number,
      storeName: p.store.name,
      itemNumber: p.itemNumber,
      stockUnitCode: p.stockUnitCode,
      quantity: Math.round(p.qty * 1000) / 1000,
    }));
    return { source: 'erp', reason: null, asOf: new Date().toISOString(), rows };
  }

  private async resolveStockTarget(skuCode: string | null): Promise<StockTarget | null> {
    if (!skuCode) return null;
    const iu = await this.itemUnits.findOne({
      where: { erpSkuCode: skuCode },
      relations: { unit: true, item: true },
    });
    if (iu?.item?.itemNumber) {
      return {
        itemNumber: iu.item.itemNumber,
        itemUnitId: iu.id,
        // A packaging unit converts into the item's base pool; only a variant
        // owns one of its own.
        stockUnitCode: iu.isStockUnit ? iu.unit?.code ?? '' : '',
        unitBaseQty: Math.max(1, iu.qty),
      };
    }
    const direct = await this.items.findOne({ where: { itemNumber: skuCode } });
    if (direct) {
      return {
        itemNumber: direct.itemNumber,
        itemUnitId: null,
        stockUnitCode: '',
        unitBaseQty: 1,
      };
    }
    const mapped = await this.idmap.findOne({
      where: { entity: 'item', erpCode: skuCode },
    });
    if (!mapped?.localId) return null;
    return {
      itemNumber: mapped.localId,
      itemUnitId: null,
      stockUnitCode: '',
      unitBaseQty: 1,
    };
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

  /**
   * Create a real, stock-affecting cash-van voucher mirroring one ERP movement.
   *
   * ALL THREE WRITES IN ONE TRANSACTION. They were separate, and the failure
   * mode was nasty: the header saved, the line failed its item_cart foreign key,
   * and the id-map that marks the movement as done never ran. That left an
   * orphan voucher with no lines, so the next sync retried the same movement,
   * collided on uq_voucher_headers_voucher_number, and wedged the batch
   * permanently. A partial mirror must roll back to nothing.
   */
  private async mirrorMovement(mv: ErpMovement, store: string): Promise<void> {
    const qty = Number(mv.quantityChanged) || 0;
    if (qty === 0) return; // cost-only / no stock effect
    const into = qty > 0; // positive → stock enters this warehouse
    const abs = Math.abs(qty);
    const kind = this.classifyKind(mv.type, qty);
    const voucherNumber = `ERP-MV-${mv.id}`;

    // A movement names a SKU; cash-van groups every SKU of a product onto ONE
    // item with a pool per variant. So the SKU code is neither an item number
    // nor, on its own, enough — resolve it to the pool it moves. Reading
    // mv.skuCode as an item number worked only for whichever SKU happened to be
    // the base, and every other unit's movement died on the item_cart foreign
    // key; resolving only as far as the item made all six colours share one
    // pool, which is just as unusable to a rep picking a colour.
    const target = await this.resolveStockTarget(mv.skuCode);
    if (!target) {
      throw new Error(
        `No cash-van item for ERP SKU "${mv.skuCode ?? '(none)'}" — ` +
          'the item catalogue has not synced this product yet.',
      );
    }
    const itemNumber = target.itemNumber;
    const item = await this.items.findOne({ where: { itemNumber } });

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
    // from/to stores drive the item_balance view — set the van's side by sign.
    const txn = this.txns.create({
      voucherNumber,
      itemNumber,
      itemName: item?.name ?? itemNumber,
      transKind: kind,
      storeNumber: store,
      fromStoreNumber: into ? null : store,
      toStoreNumber: into ? store : null,
      itemQty: String(abs),
      unitPrice: '0',
      // The ERP ledger is ALREADY in base pieces — a packaging line is
      // multiplied into them at posting (purchasing/actions.ts, receivePO) — so
      // item_qty stays `abs` and qty_of_unit is what those pieces are in the
      // resolved unit, keeping the entity's invariant
      // item_qty = qty_of_unit × unit_base_qty. For a variant the factor is 1
      // and all three are the same number.
      qtyOfUnit: String(abs / target.unitBaseQty),
      unitBaseQty: target.unitBaseQty,
      // The pool this movement lands in. Without it every colour's stock piled
      // into the item's base pool and the six colours were indistinguishable.
      stockUnitCode: target.stockUnitCode,
      itemUnitId: target.itemUnitId,
      signedQty: String(into ? abs : -abs),
      taxPercentage: '0',
      discountPercentage: '0',
      discountValue: '0',
      total: '0',
      netTotal: '0',
    });
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(VoucherHeader).save(header);
      await em.getRepository(VoucherTransaction).save(txn);
      await em.getRepository(ErpIdMap).save(
        em.getRepository(ErpIdMap).create({
          entity: 'movement',
          erpId: mv.id,
          erpCode: mv.skuCode ?? null,
          localId: voucherNumber,
        }),
      );
    });
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
    // Read once per pull, not per salesman: the answer cannot change mid-batch,
    // and a settings failure must not lock anyone out, so it defaults to false.
    const activationOn = await this.settings
      .salesmanActivationEnabled()
      .catch(() => false);
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
            // Licensing: a salesman arriving FROM the ERP is frozen on the same
            // terms as one created in the dashboard, or the lock would be
            // trivially bypassed by adding the salesman in the ERP instead.
            provisionRep(em, {
              code: w.code!,
              nameAr: w.name ?? w.code!,
              frozen: activationOn,
            }),
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

    // Mirror EVERY non-base unit into item_units — larger packs (طرد, multiplier
    // 24) and same-size units alike.
    //
    // Same-size units used to be dropped on the assumption that multiplier 1
    // means "identical to the base, nothing to convert". That is true of the
    // arithmetic and false of the business: a unit is also how the ERP models a
    // VARIANT — a colour, a flavour, a scent — all of which are the same size
    // and all of which a salesman has to be able to pick in the field. Skipping
    // them meant six colours collapsed into one item and the rep sold an
    // arbitrary one.
    for (const s of skus) {
      if (s === base) continue;
      const mult = Math.max(1, Math.round(Number(s.unitMultiplier) || 1));
      const unitName = (s.unitLabel || s.label || '').trim();
      if (!unitName) continue; // unnamed units have nothing to show or match on
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
      // Both of these are written on UPDATE as well as INSERT, and that is what
      // migrates an install that already ran: its colour units exist, so this
      // loop finds them and an insert-only write would never touch them again.
      // They carry no SKU and `is_stock_unit = false` (the migration's
      // behaviour-preserving default), i.e. they still all share the item's base
      // pool. Re-writing on every sync is what flips those 66 rows onto their
      // own pools — no backfill script, no manual step, just the next sync.
      iu.erpSkuCode = s.sku;
      // A same-size sibling SKU is how the ERP spells a VARIANT — a colour, a
      // flavour, a scent: a different good with its own stock. A pack (mult > 1)
      // is a way to ENTER a quantity of the same goods and keeps drawing from
      // the item's base pool, so it stays a packaging unit. Flipping a client's
      // كرتونة ×12 to its own pool would zero it on upgrade and fail their next
      // sale (spec §2.3).
      iu.isStockUnit = mult === 1;
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
