import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';

import { VoucherHeader } from '../vouchers/entities/voucher-header.entity';
import { VoucherTransaction } from '../vouchers/entities/voucher-transaction.entity';
import { TobaccoTaxProfile } from '../items/entities/tobacco-tax-profile.entity';
import { Collection } from '../collections/entities/collection.entity';
import { Customer } from '../customers/entities/customer.entity';
import { SalesmanSettlement } from '../reports/entities/salesman-settlement.entity';
import { SettingsService } from '../settings/settings.service';
import { ErpHttpClient } from './erp-http.client';
import { HubHttpClient } from './hub-http.client';
import { ErpIdMap } from './entities/erp-id-map.entity';
import {
  ErpOutbox,
  ErpOutboxKind,
  ErpOutboxStatus,
} from './entities/erp-outbox.entity';

/** Document kinds the Integration Hub has a sync endpoint for (see SPEC-integration-hub). */
const HUB_KINDS: ReadonlySet<ErpOutboxKind> = new Set<ErpOutboxKind>([
  'SALE_INVOICE',
  'SALES_RETURN',
  'PAYMENT',
  'STOCK_TRANSFER',
]);

const MAX_ATTEMPTS = 6;
const BATCH = 20;

@Injectable()
export class ErpOutboxService {
  private readonly logger = new Logger(ErpOutboxService.name);
  private draining = false;

  constructor(
    private readonly erp: ErpHttpClient,
    private readonly hub: HubHttpClient,
    private readonly settings: SettingsService,
    @InjectRepository(ErpOutbox) private readonly outbox: Repository<ErpOutbox>,
    @InjectRepository(ErpIdMap) private readonly idmap: Repository<ErpIdMap>,
    @InjectRepository(VoucherHeader) private readonly headers: Repository<VoucherHeader>,
    @InjectRepository(VoucherTransaction) private readonly lines: Repository<VoucherTransaction>,
    @InjectRepository(TobaccoTaxProfile) private readonly tobaccoProfiles: Repository<TobaccoTaxProfile>,
    @InjectRepository(Collection) private readonly collections: Repository<Collection>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(SalesmanSettlement) private readonly salesmanSettlements: Repository<SalesmanSettlement>,
  ) {}

  /** Queue a van document for push to the ERP (best-effort; never throws to the caller). */
  async enqueue(kind: ErpOutboxKind, ref: string): Promise<void> {
    try {
      const existing = await this.outbox.findOne({ where: { kind, ref } });
      if (existing && existing.status !== 'failed' && existing.status !== 'dead_letter') return;
      const row = existing ?? this.outbox.create({ kind, ref });
      row.status = 'pending';
      row.nextAttemptAt = new Date();
      await this.outbox.save(row);
    } catch (e) {
      this.logger.warn(`enqueue ${kind} ${ref} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  list(status?: ErpOutboxStatus): Promise<ErpOutbox[]> {
    return this.outbox.find({
      where: status ? { status } : {},
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }

  async retry(id: string): Promise<ErpOutbox> {
    const row = await this.outbox.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Outbox item ${id} not found`);
    if (row.status === 'posted') return row;
    row.status = 'pending';
    row.nextAttemptAt = new Date();
    await this.outbox.save(row);
    await this.pushOne(row);
    return this.outbox.findOneByOrFail({ id });
  }

  /** Drain due rows every 30s when ERP mode is on. */
  @Interval(30000)
  async drain(): Promise<void> {
    if (this.draining) return;
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey) return;
    this.draining = true;
    try {
      const due = await this.outbox.find({
        where: { status: 'pending', nextAttemptAt: LessThanOrEqual(new Date()) },
        order: { createdAt: 'ASC' },
        take: BATCH,
      });
      for (const row of due) await this.pushOne(row);
    } finally {
      this.draining = false;
    }
  }

  private async pushOne(row: ErpOutbox): Promise<void> {
    try {
      // Route through the Integration Hub when it's enabled + configured and the
      // doc kind has a Hub sync endpoint; otherwise push directly to the ERP.
      const useHub = HUB_KINDS.has(row.kind) && (await this.hub.isActive());
      const calls = await this.buildCalls(row, useHub);
      if (!calls || calls.length === 0) {
        return this.fail(row, 'payload could not be built (source missing)');
      }
      // A document may map to >1 call; each carries its own externalId, so a
      // retry replays them idempotently. (Most kinds are a single call.)
      let lastData: unknown = null;
      for (const c of calls) {
        const res = useHub
          ? await this.hub.postSync(c.path, c.body)
          : await this.erp.post(c.path, c.body, c.idem ?? row.ref);
        if (!res.ok) {
          return this.fail(row, res.error ?? `${useHub ? 'Hub' : 'ERP'} rejected the document`);
        }
        lastData = res.data;
      }
      row.status = 'posted';
      row.error = null;
      row.resultRef = this.extractResultRef(lastData);
      await this.outbox.save(row);
      if (row.kind === 'SALE_INVOICE' && row.resultRef) {
        await this.mapVoucher(row.ref, row.resultRef);
      }
    } catch (e) {
      await this.fail(row, e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Resolve a queued document to the call(s) needed to mirror it. When `useHub`,
   * targets the Hub `/api/sync/*` shape (single stock-transfers doc, invoice-level
   * payment); otherwise the direct-ERP shape (two stock-adjustments, receipt).
   */
  private async buildCalls(
    row: ErpOutbox,
    useHub: boolean,
  ): Promise<Array<{ path: string; body: Record<string, unknown>; idem?: string }> | null> {
    if (useHub) {
      if (row.kind === 'STOCK_TRANSFER') {
        const t = await this.buildHubTransfer(row.ref);
        return t ? [t] : null;
      }
      if (row.kind === 'PAYMENT') {
        const p = await this.buildHubPayment(row.ref);
        return p ? [p] : null;
      }
      // SALE_INVOICE + SALES_RETURN reuse the direct builders — their bodies +
      // path segments ('sales-invoices' / 'sales-returns') match the Hub sync API.
      const one = await this.buildPayload(row);
      return one ? [one] : null;
    }
    // ── Direct ERP ────────────────────────────────────────────────────────────
    // A TRANSFER becomes TWO immediate stock-adjustments (OUT source + IN dest)
    // so ERP stock moves RIGHT AWAY — the ERP `stock-transfers` document instead
    // sits PENDING_DISPATCH and doesn't touch stock until dispatch+receive.
    if (row.kind === 'STOCK_TRANSFER') return this.buildTransferCalls(row.ref);
    const one = await this.buildPayload(row);
    return one ? [one] : null;
  }

  /** Hub payment (invoice-level) from a confirmed collection. See D7 in the spec. */
  private async buildHubPayment(
    collectionId: string,
  ): Promise<{ path: string; body: Record<string, unknown> } | null> {
    const col = await this.collections.findOne({ where: { id: collectionId } });
    if (!col) return null;
    return {
      path: 'payments',
      body: {
        externalId: collectionId,
        amount: col.amount / 1000, // fils → JOD major (ERP expects decimal)
        paymentMethod: col.method === 'cheque' ? 'CHECK' : 'CASH',
        notes: col.note ?? undefined,
      },
    };
  }

  /** Hub stock-transfer (one document with from/to warehouse codes + lines). */
  private async buildHubTransfer(
    voucherNumber: string,
  ): Promise<{ path: string; body: Record<string, unknown> } | null> {
    const header = await this.headers.findOne({ where: { voucherNumber } });
    if (!header) return null;
    const lines = await this.lines.find({ where: { voucherNumber } });
    if (!lines.length) return null;
    const from = lines.find((l) => l.fromStoreNumber)?.fromStoreNumber;
    const to = lines.find((l) => l.toStoreNumber)?.toStoreNumber;
    if (!from || !to) return null; // a transfer needs both endpoints
    return {
      path: 'stock-transfers',
      body: {
        externalId: voucherNumber,
        deviceId: header.userCode,
        fromWarehouseCode: from,
        toWarehouseCode: to,
        date: header.inDate,
        lines: lines.map((l) => ({
          skuCode: l.itemNumber,
          quantity: Math.round(Number(l.itemQty) || 0),
        })),
      },
    };
  }

  private async fail(row: ErpOutbox, error: string): Promise<void> {
    row.attempts += 1;
    row.error = error;
    if (row.attempts >= MAX_ATTEMPTS) {
      row.status = 'dead_letter';
    } else {
      row.status = 'pending';
      const backoffMs = Math.min(60_000 * row.attempts * row.attempts, 3_600_000);
      row.nextAttemptAt = new Date(Date.now() + backoffMs);
    }
    await this.outbox.save(row);
    this.logger.warn(`outbox ${row.kind} ${row.ref} attempt ${row.attempts}: ${error}`);
  }

  /** Build the ERP request for a queued document, or null if its source is gone. */
  private async buildPayload(
    row: ErpOutbox,
  ): Promise<{ path: string; body: Record<string, unknown> } | null> {
    if (row.kind === 'SALE_INVOICE') return this.buildSale(row.ref);
    if (row.kind === 'SALES_RETURN') return this.buildReturn(row.ref);
    if (row.kind === 'SALES_ORDER') return this.buildOrder(row.ref);
    if (row.kind === 'STOCK_ADJUSTMENT') return this.buildAdjustment(row.ref);
    // STOCK_TRANSFER is handled as two calls in buildCalls (buildTransferCalls).
    if (row.kind === 'PAYMENT') return this.buildPayment(row.ref);
    if (row.kind === 'CASH_SETTLEMENT') return this.buildSettlement(row.ref);
    return null;
  }

  /**
   * Build an ERP customer receipt from a confirmed cash-van collection. The
   * collection IS the payment receipt: pushed at the customer level (on-account),
   * allocated to an invoice only if a resolvable ERP invoice number is known.
   */
  private async buildPayment(
    collectionId: string,
  ): Promise<{ path: string; body: Record<string, unknown> } | null> {
    const col = await this.collections.findOne({ where: { id: collectionId } });
    if (!col) return null;
    const customer = await this.customers.findOne({ where: { id: col.customerId } });
    if (!customer?.customerNumber) return null; // can't receipt without a customer code
    // Resolve to the ERP identity: ERP-origin customers carry a derived
    // `ERP-…` number the ERP can't match by code, so prefer the mapped ERP uuid
    // (customerId). Falls back to customerCode for van-native customers.
    const ref = await this.customerRef(customer.customerNumber);
    if (!('customerId' in ref) && !('customerCode' in ref)) return null;
    return {
      path: 'receipts',
      body: {
        externalId: collectionId,
        ...ref,
        amount: col.amount / 1000, // fils → JOD major (ERP expects decimal)
        paymentMethod: col.method === 'cheque' ? 'CHECK' : 'CASH',
        notes: col.note ?? undefined,
      },
    };
  }

  /**
   * The van store for a voucher == the salesman code == the ERP warehouse code
   * (one shared identity). Prefer a line's own store, fall back to the voucher's
   * userCode (the salesman who created it).
   */
  private vanStoreOf(lines: VoucherTransaction[], userCode: string): string {
    for (const l of lines) {
      const s = l.storeNumber ?? l.fromStoreNumber ?? l.toStoreNumber;
      if (s) return s;
    }
    return userCode;
  }

  /** Build an ERP sales-order from a cash-van ORDER voucher (resolves UUIDs via id-map). */
  private async buildOrder(
    voucherNumber: string,
  ): Promise<{ path: string; body: Record<string, unknown> } | null> {
    const header = await this.headers.findOne({ where: { voucherNumber } });
    if (!header?.customerNumber) return null;
    const cust = await this.idmap.findOne({
      where: { entity: 'customer', localId: header.customerNumber },
    });
    if (!cust?.erpId) return null; // customer not mirrored to the ERP yet
    const lines = await this.lines.find({ where: { voucherNumber } });
    const orderLines: Array<{ skuId: string; quantity: number }> = [];
    for (const l of lines) {
      const sku = await this.idmap.findOne({ where: { entity: 'item', localId: l.itemNumber } });
      if (!sku?.erpId) return null; // item not mirrored yet
      orderLines.push({ skuId: sku.erpId, quantity: Math.round(Number(l.itemQty) || 0) });
    }
    return { path: 'sales-orders', body: { customerId: cust.erpId, lines: orderLines } };
  }

  /**
   * Resolve a cash-van customer to the identity the ERP can look up: prefer the
   * ERP customer UUID (`customerId`, via the id-map) — required for ERP-origin
   * customers that have NO `code` (their cash-van number is the derived `ERP-…`,
   * which the ERP can't match → CUSTOMER_NOT_FOUND). Fall back to `customerCode`
   * for customers whose code IS their cash-van number.
   */
  private async customerRef(
    customerNumber: string | null | undefined,
  ): Promise<{ customerId: string } | { customerCode: string } | Record<string, never>> {
    if (!customerNumber) return {};
    const map = await this.idmap.findOne({
      where: { entity: 'customer', localId: customerNumber },
    });
    if (map?.erpId) return { customerId: map.erpId };
    return { customerCode: customerNumber };
  }

  /**
   * Resolve an item's tax rate% to the org's ERP `taxRateId`, so the ERP applies
   * the SAME tax the dashboard computed (without it the ERP silently taxes at 0%).
   * The ERP tax-rate list is cached for the process lifetime (rates rarely change;
   * a restart refreshes it).
   */
  private taxRateMap: Map<number, string> | null = null;
  private async taxRateIdForPct(pct: number): Promise<string | undefined> {
    if (!this.taxRateMap) {
      try {
        const { data } = await this.erp.list<{ id: string; percentage: number }>(
          'tax-rates',
          { pageSize: 100 },
        );
        this.taxRateMap = new Map(
          data.map((t) => [Math.round(Number(t.percentage) || 0), t.id]),
        );
      } catch {
        return undefined;
      }
    }
    return this.taxRateMap.get(Math.round(pct || 0));
  }

  /**
   * Resolve a local tobacco profile id → the ERP profile id (stored as `erpId`
   * on the synced profile). Returns undefined if unknown, in which case the ERP
   * rejects the line (surfacing the misconfiguration) rather than silently
   * dropping the tobacco tax.
   */
  private async erpTobaccoProfileId(localId: string | null | undefined): Promise<string | undefined> {
    if (!localId) return undefined;
    const p = await this.tobaccoProfiles.findOne({ where: { id: localId } }).catch(() => null);
    return p?.erpId ?? undefined;
  }

  private async buildSale(
    voucherNumber: string,
  ): Promise<{ path: string; body: Record<string, unknown> } | null> {
    const header = await this.headers.findOne({ where: { voucherNumber } });
    if (!header) return null;
    const lines = await this.lines.find({ where: { voucherNumber } });
    const items = await Promise.all(
      lines.map(async (l) => {
        // quantity is in BASE pieces (item_qty), so send the per-PIECE price.
        // For base-unit lines (unit_base_qty = 1) this equals unit_price exactly.
        const baseQty = l.unitBaseQty && l.unitBaseQty > 0 ? l.unitBaseQty : 1;
        const base = {
          skuCode: l.itemNumber, // cash-van item_number == ERP sku (set on inbound sync)
          quantity: Number(l.itemQty) || 0,
          unitPrice: (Number(l.unitPrice) || 0) / baseQty, // JOD major, per base piece
          discount: Number(l.discountValue) || 0, // resolved line discount (incl header share)
        };
        // Tobacco line: send the flag + ERP profile id + consumer price (no
        // taxRateId — the ERP re-computes the tobacco tax authoritatively).
        if (l.isTobaccoLine) {
          const erpProfileId = await this.erpTobaccoProfileId(l.tobaccoTaxProfileId);
          return {
            ...base,
            isTobaccoLine: true,
            tobaccoTaxProfileId: erpProfileId,
            consumerPrice: (l.consumerPriceFils ?? 0) / 1000, // JOD major per base piece
          };
        }
        return { ...base, taxRateId: await this.taxRateIdForPct(Number(l.taxPercentage) || 0) };
      }),
    );
    return {
      path: 'sales-invoices',
      body: {
        externalId: voucherNumber,
        deviceId: header.userCode,
        ...(await this.customerRef(header.customerNumber)),
        warehouseCode: this.vanStoreOf(lines, header.userCode), // attribute to the van
        invoiceDate: header.inDate,
        items,
      },
    };
  }

  private async buildReturn(
    voucherNumber: string,
  ): Promise<{ path: string; body: Record<string, unknown> } | null> {
    const header = await this.headers.findOne({ where: { voucherNumber } });
    if (!header) return null;
    // The ERP needs the ORIGINAL ERP invoice number; resolve it from the
    // referenced sale's push result.
    const ref = header.referenceVoucherNumber;
    if (!ref) return null;
    const map = await this.idmap.findOne({ where: { entity: 'voucher', localId: ref } });
    const originalInvoiceNumber = map?.erpCode ?? ref;
    const lines = await this.lines.find({ where: { voucherNumber } });
    return {
      path: 'sales-returns',
      body: {
        externalId: voucherNumber,
        deviceId: header.userCode,
        ...(await this.customerRef(header.customerNumber)),
        warehouseCode: this.vanStoreOf(lines, header.userCode), // physical return to the van
        originalInvoiceNumber,
        lines: lines.map((l) => ({
          skuCode: l.itemNumber,
          quantity: Number(l.itemQty) || 0,
        })),
      },
    };
  }

  /** Build an ERP stock-adjustment from a cash-van IN/OUT voucher. */
  private async buildAdjustment(
    voucherNumber: string,
  ): Promise<{ path: string; body: Record<string, unknown> } | null> {
    const header = await this.headers.findOne({ where: { voucherNumber } });
    if (!header) return null;
    const lines = await this.lines.find({ where: { voucherNumber } });
    if (!lines.length) return null;
    return {
      path: 'stock-adjustments',
      body: {
        externalId: voucherNumber,
        deviceId: header.userCode,
        warehouseCode: this.vanStoreOf(lines, header.userCode),
        type: header.transKind === 'IN' ? 'IN' : 'OUT',
        items: lines.map((l) => ({
          skuCode: l.itemNumber,
          quantity: Math.round(Number(l.itemQty) || 0),
        })),
      },
    };
  }

  /**
   * A van-to-van (or store-to-van) TRANSFER → TWO immediate ERP stock-adjustments:
   * an OUT from the source warehouse + an IN to the destination. This moves ERP
   * stock RIGHT AWAY (the ERP `stock-transfers` document would instead sit
   * PENDING_DISPATCH and not touch stock until dispatch+receive). Each call has a
   * distinct externalId (`<voucher>-OUT` / `<voucher>-IN`) so a retry replays both
   * idempotently. The cash-van side already moved its own stock via the one
   * TRANSFER voucher — no extra IN/OUT vouchers locally.
   */
  private async buildTransferCalls(
    voucherNumber: string,
  ): Promise<Array<{ path: string; body: Record<string, unknown>; idem: string }> | null> {
    const header = await this.headers.findOne({ where: { voucherNumber } });
    if (!header) return null;
    const lines = await this.lines.find({ where: { voucherNumber } });
    if (!lines.length) return null;
    const from = lines.find((l) => l.fromStoreNumber)?.fromStoreNumber;
    const to = lines.find((l) => l.toStoreNumber)?.toStoreNumber;
    if (!from || !to) return null; // a transfer needs both endpoints
    const items = lines.map((l) => ({
      skuCode: l.itemNumber,
      quantity: Math.round(Number(l.itemQty) || 0),
    }));
    return [
      {
        path: 'stock-adjustments',
        idem: `${voucherNumber}-OUT`,
        body: {
          externalId: `${voucherNumber}-OUT`,
          deviceId: header.userCode,
          warehouseCode: from,
          type: 'OUT',
          items,
        },
      },
      {
        path: 'stock-adjustments',
        idem: `${voucherNumber}-IN`,
        body: {
          externalId: `${voucherNumber}-IN`,
          deviceId: header.userCode,
          warehouseCode: to,
          type: 'IN',
          items,
        },
      },
    ];
  }

  /**
   * Build an ERP cash-settlement request from a salesman settlement record.
   * Records the admin receiving cash from the salesman (internal cash transfer).
   * The ERP creates a van_cash_settlement financial transaction for accounting.
   */
  private async buildSettlement(
    settlementId: string,
  ): Promise<{ path: string; body: Record<string, unknown> } | null> {
    const s = await this.salesmanSettlements.findOne({ where: { id: settlementId } });
    if (!s) return null;
    const receivedFils = Number(s.receivedFils);
    if (receivedFils <= 0) return null; // nothing was handed over — skip ERP entry
    // Resolve the salesman's van warehouse code via the rep → user code relationship.
    // The rep_id links to the reps table; query via the rep entity to get the code.
    const rep = await this.idmap.findOne({ where: { entity: 'rep', localId: s.repId } }).catch(() => null);
    return {
      path: 'cash-settlements',
      body: {
        externalId: settlementId,
        deviceId: rep?.erpCode ?? s.repId,
        amount: receivedFils / 1000, // fils → JOD major
        date: s.periodTo,
        note: s.note ?? undefined,
      },
    };
  }

  private extractResultRef(data: unknown): string | null {
    if (data && typeof data === 'object') {
      const top = data as Record<string, unknown>;
      // Hub replay: { duplicate: true, targetDocumentNumber }.
      if (typeof top.targetDocumentNumber === 'string') return top.targetDocumentNumber;
      // Success: the ERP document, wrapped as { data: {...} } (ERP) or flat (Hub forward).
      const d = (top.data as Record<string, unknown> | undefined) ?? top;
      const num =
        d?.invoiceNumber ?? d?.returnNumber ?? d?.transferNumber ?? d?.paymentId;
      if (typeof num === 'string') return num;
    }
    return null;
  }

  private async mapVoucher(voucherNumber: string, erpInvoiceNumber: string): Promise<void> {
    let m = await this.idmap.findOne({ where: { entity: 'voucher', erpId: voucherNumber } });
    if (!m) m = this.idmap.create({ entity: 'voucher', erpId: voucherNumber });
    m.localId = voucherNumber;
    m.erpCode = erpInvoiceNumber;
    await this.idmap.save(m);
  }
}
