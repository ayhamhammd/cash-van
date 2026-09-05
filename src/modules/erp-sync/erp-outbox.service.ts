import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';

import { VoucherHeader } from '../vouchers/entities/voucher-header.entity';
import { VoucherTransaction } from '../vouchers/entities/voucher-transaction.entity';
import { Payment } from '../vouchers/entities/payment.entity';
import { ItemUnit } from '../units/entities/item-unit.entity';
import { TobaccoTaxProfile } from '../items/entities/tobacco-tax-profile.entity';
import { Collection } from '../collections/entities/collection.entity';
import { Customer } from '../customers/entities/customer.entity';
import { SalesmanSettlement } from '../reports/entities/salesman-settlement.entity';
import { StockRequest } from '../stock-requests/entities/stock-request.entity';
import { Rep } from '../reps/entities/rep.entity';
import { SettingsService } from '../settings/settings.service';
import { CashAccountsService } from '../cash-accounts/cash-accounts.service';
import { ErpHttpClient } from './erp-http.client';
import { ErpIdMap } from './entities/erp-id-map.entity';
import {
  ErpOutbox,
  ErpOutboxKind,
  ErpOutboxStatus,
} from './entities/erp-outbox.entity';

const MAX_ATTEMPTS = 6;
// Read from process.env, not ConfigService: @Interval() is evaluated when the
// class is defined, before DI exists. Validated in validation.schema.ts.
const DRAIN_INTERVAL_MS = parseInt(process.env.ERP_OUTBOX_DRAIN_MS ?? '30000', 10);
const BATCH = 20;
// A 429 is transient (the ERP per-key window resets in 60s), so we reschedule past
// the window WITHOUT consuming a dead-letter attempt — rate limiting must never
// permanently fail a document.
const RATE_LIMIT_BACKOFF_MS = 65_000;

// CashVan payment_type → ERP sales-invoice paymentMethod. CREDIT has no method
// (an on-account sale). Cheques are treated as PAID immediately (mapped to CHECK).
const ERP_PAYMENT_METHOD: Record<string, string> = {
  CASH: 'CASH',
  CHEQUE: 'CHECK',
  CARD: 'CARD',
  TRANSFER: 'BANK_TRANSFER',
};

/**
 * A payload that can NEVER be built, however many times we retry — an order with
 * no customer, a return with no source sale.
 *
 * Distinct from returning null (which means "not yet — the prerequisite may
 * still arrive"), because the two need opposite handling: one should dead-letter
 * on the first look, the other should back off and try again. Conflating them is
 * what made ORD-101000002 burn six attempts on a condition that could not change.
 */
export class TerminalPayloadError extends Error {}

@Injectable()
export class ErpOutboxService {
  private readonly logger = new Logger(ErpOutboxService.name);
  private draining = false;

  constructor(
    private readonly erp: ErpHttpClient,
    private readonly settings: SettingsService,
    private readonly cashAccounts: CashAccountsService,
    @InjectRepository(ErpOutbox) private readonly outbox: Repository<ErpOutbox>,
    @InjectRepository(ErpIdMap) private readonly idmap: Repository<ErpIdMap>,
    @InjectRepository(VoucherHeader) private readonly headers: Repository<VoucherHeader>,
    @InjectRepository(VoucherTransaction) private readonly lines: Repository<VoucherTransaction>,
    @InjectRepository(TobaccoTaxProfile) private readonly tobaccoProfiles: Repository<TobaccoTaxProfile>,
    @InjectRepository(Collection) private readonly collections: Repository<Collection>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(SalesmanSettlement) private readonly salesmanSettlements: Repository<SalesmanSettlement>,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(ItemUnit) private readonly itemUnits: Repository<ItemUnit>,
    @InjectRepository(StockRequest) private readonly stockRequests: Repository<StockRequest>,
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
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

  /**
   * Drain due rows on the ERP_OUTBOX_DRAIN_MS interval.
   *
   * When the ERP connection is incomplete this used to return silently, so a
   * queue full of `pending` vouchers looked identical to an empty one: nothing
   * reached the ERP and nothing said why. It now names the missing piece — but
   * only when rows are actually waiting, so a site with ERP switched off on
   * purpose doesn't spam its log every interval.
   */
  @Interval(DRAIN_INTERVAL_MS)
  async drain(): Promise<void> {
    if (this.draining) return;
    // Keep the error. getErpConfig() THROWS when the stored API key can't be
    // decrypted — which is what happens if JWT_SECRET or the KMS key changes
    // between deploys. Swallowing it into `null` made that indistinguishable
    // from "ERP is switched off", so a redeploy could silently stall every
    // voucher in the queue and point the operator at the wrong setting.
    let cfg: Awaited<ReturnType<SettingsService['getErpConfig']>> | null = null;
    let cfgError: string | null = null;
    try {
      cfg = await this.settings.getErpConfig();
    } catch (e) {
      cfgError = e instanceof Error ? e.message : String(e);
    }
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey) {
      const waiting = await this.outbox.count({ where: { status: 'pending' } }).catch(() => 0);
      if (waiting > 0) {
        const missing = cfgError
          ? `the ERP settings could not be read (${cfgError}). If the API key ` +
            'cannot be decrypted, re-enter it in Settings → ERP — a changed ' +
            'JWT_SECRET or KMS key invalidates the stored value'
          : !cfg?.enabled
            ? 'ERP sync is switched OFF in Settings'
            : !cfg.baseUrl
              ? 'ERP base URL is not set'
              : 'ERP API key is not set';
        this.logger.warn(
          `${waiting} voucher(s) stuck in the outbox: ${missing}. ` +
            'They will push automatically once the ERP connection is complete.',
        );
      }
      return;
    }
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
      let calls;
      try {
        calls = await this.buildCalls(row);
      } catch (e) {
        // Terminal on the FIRST look: no number of retries invents a customer.
        if (e instanceof TerminalPayloadError) return this.failTerminal(row, e.message);
        throw e;
      }
      if (!calls || calls.length === 0) {
        // Still the "not yet" case — a prerequisite that may arrive on a later
        // sync. Retries with backoff are the right behaviour here.
        return this.fail(row, 'waiting on a prerequisite that has not synced yet');
      }
      // A document may map to >1 call; each carries its own externalId, so a
      // retry replays them idempotently. (Most kinds are a single call.)
      let lastData: unknown = null;
      for (const c of calls) {
        const res = await this.erp.post(c.path, c.body, c.idem ?? row.ref);
        if (!res.ok) {
          // Rate limited: back off past the window and retry, no attempt spent.
          if (res.status === 429) return this.softRetry(row, res.error ?? 'RATE_LIMITED');
          return this.fail(row, res.error ?? 'ERP rejected the document');
        }
        lastData = res.data;
      }
      row.status = 'posted';
      row.error = null;
      row.resultRef = this.extractResultRef(lastData);

      // The ERP posts the GL entry in a savepoint: a missing posting rule skips
      // the journal but still returns 201, so a misconfigured org would other-
      // wise produce sales that look synced here and are invisible in the GL.
      const posting = this.extractPostingInfo(lastData);
      row.journalId = posting.journalId;
      row.paymentSkipped = posting.paymentSkipped;
      await this.outbox.save(row);
      this.warnOnPostingGap(row);
      // A customer only becomes ERP-mapped once it actually exists there. Writing
      // the map on enqueue would make an unexported customer look synced and stop
      // it ever being retried.
      if (row.kind === 'CUSTOMER') {
        // Find-then-update, not create+save: a blind insert added a SECOND map
        // row on every retry, and the customer sync then resolves an ambiguous
        // identity for the same code.
        const existing = await this.idmap.findOne({
          where: { entity: 'customer', localId: row.ref },
        });
        const map =
          existing ?? this.idmap.create({ entity: 'customer', localId: row.ref });
        map.erpId = row.resultRef ?? row.ref;
        map.erpCode = row.ref;
        await this.idmap.save(map);
      }
      if (row.kind === 'SALE_INVOICE' && row.resultRef) {
        await this.mapVoucher(row.ref, row.resultRef);
        // A partially-paid sale posts as CREDIT; settle its paid portion with a
        // companion receipt allocated to the just-created invoice (Phase 2). Only
        // enqueued now — after the invoice exists + is id-mapped — so the receipt
        // can reference the ERP invoice number. enqueue() dedups on (kind, ref).
        if (await this.splitPaidPortion(row.ref)) {
          await this.enqueue('SALE_SPLIT_RECEIPT', row.ref);
        }
      }
    } catch (e) {
      await this.fail(row, e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Resolve a queued document to the call(s) needed to mirror it, using the
   * direct-ERP shape (two stock-adjustments for a transfer, receipt for a payment).
   */
  private async buildCalls(
    row: ErpOutbox,
  ): Promise<Array<{ path: string; body: Record<string, unknown>; idem?: string }> | null> {
    // A TRANSFER becomes TWO immediate stock-adjustments (OUT source + IN dest)
    // so ERP stock moves RIGHT AWAY — the ERP `stock-transfers` document instead
    // sits PENDING_DISPATCH and doesn't touch stock until dispatch+receive.
    if (row.kind === 'STOCK_TRANSFER') return this.buildTransferCalls(row.ref);
    if (row.kind === 'REP_SETTLEMENT_JOURNAL') {
      const call = await this.buildRepSettlementJournal(row.ref);
      return call ? [call] : null;
    }
    // Split-sale receipt carries its own externalId/idem (`<voucher>-PAY`) so it
    // never replays as the sale's push.
    if (row.kind === 'SALE_SPLIT_RECEIPT') {
      const call = await this.buildSplitReceipt(row.ref);
      return call ? [call] : null;
    }
    const one = await this.buildPayload(row);
    return one ? [one] : null;
  }

  /** Transient rate-limit: reschedule past the ERP window without spending an attempt. */
  private async softRetry(row: ErpOutbox, reason: string): Promise<void> {
    row.status = 'pending';
    row.error = reason;
    row.nextAttemptAt = new Date(Date.now() + RATE_LIMIT_BACKOFF_MS);
    await this.outbox.save(row);
    this.logger.log(
      `outbox ${row.kind} ${row.ref} rate-limited — retrying in ${RATE_LIMIT_BACKOFF_MS / 1000}s (attempt ${row.attempts}, not counted)`,
    );
  }

  /**
   * Dead-letter now, without spending the retry budget.
   *
   * For failures whose cause cannot change on its own. Burning five attempts and
   * an hour of backoff only delays the operator seeing a message they need to
   * act on.
   */
  private async failTerminal(row: ErpOutbox, error: string): Promise<void> {
    row.attempts += 1;
    row.error = error;
    row.status = 'dead_letter';
    await this.outbox.save(row);
    this.logger.warn(`outbox ${row.kind} ${row.ref} DEAD (terminal): ${error}`);
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
    if (row.kind === 'CUSTOMER') return this.buildCustomer(row.ref);
    if (row.kind === 'VAN_STOCK_REQUEST') return this.buildVanStockRequest(row.ref);
    if (row.kind === 'SALE_INVOICE') return this.buildSale(row.ref);
    if (row.kind === 'SALES_RETURN') return this.buildReturn(row.ref);
    if (row.kind === 'SALES_ORDER') return this.buildOrder(row.ref);
    if (row.kind === 'STOCK_ADJUSTMENT') return this.buildAdjustment(row.ref);
    // STOCK_TRANSFER is handled as two calls in buildCalls (buildTransferCalls).
    if (row.kind === 'PAYMENT') return this.buildPayment(row.ref);
    if (row.kind === 'CASH_SETTLEMENT') return this.buildSettlement(row.ref);
    // REP_SETTLEMENT_JOURNAL is handled in buildCalls (carries its own externalId/idem).
    return null;
  }

  /**
   * Build a balanced ERP manual journal that mirrors an EOD settlement's box→destination
   * transfers (DR destinations, CR rep boxes). The lines are reconstructed from the
   * settlement's ledger rows by the cash-accounts service; null means the accounts aren't
   * ERP-linked (the settlement then falls back to the legacy cash-settlement push).
   */
  private async buildRepSettlementJournal(
    settlementId: string,
  ): Promise<{ path: string; body: Record<string, unknown>; idem: string } | null> {
    const journal = await this.cashAccounts.buildSettlementJournal(settlementId);
    if (!journal) return null;
    return {
      path: 'journal-entries',
      idem: journal.externalId,
      body: {
        externalId: journal.externalId,
        description: journal.description,
        date: journal.date,
        lines: journal.lines,
      },
    };
  }

  /**
   * Build the ERP create/upsert call for a cash-van customer.
   *
   * `ref` is the customer_number, which is also the ERP `code` and the
   * Idempotency-Key — so a retry after a timeout cannot create a duplicate
   * customer in the ERP, and re-running an export is safe.
   *
   * Read at PUSH time, not at enqueue time: a customer edited while the ERP was
   * down should export its current details, not the ones it had when it was
   * first queued.
   */
  private async buildCustomer(
    ref: string,
  ): Promise<{ path: string; body: Record<string, unknown>; idem?: string } | null> {
    const c = await this.customers.findOne({ where: { customerNumber: ref } });
    if (!c) return null;
    return {
      path: 'customers',
      idem: ref,
      body: {
        code: c.customerNumber,
        name: c.nameAr || c.customerName || c.customerNumber,
        ...(c.phone ? { phone: c.phone } : {}),
        ...(c.email ? { email: c.email } : {}),
        ...(c.tin ? { taxNumber: c.tin } : {}),
        // JOD major here; the ERP scales it on receipt.
        ...(c.creditLimit != null ? { creditLimit: Number(c.creditLimit) } : {}),
      },
    };
  }

  /**
   * Build the ERP's copy of an APPROVED van stock request.
   *
   * Informational only — it tells the warehouse what a van is owed. No stock
   * moves from it. The movement reaches the ERP separately, as the TRANSFER
   * voucher the van raises on receipt, and pushing both as movements here would
   * double every request.
   *
   * Lines granted zero are dropped: the manager reviewed and refused them, so
   * putting them in front of the warehouse as work would be wrong.
   */
  private async buildVanStockRequest(
    requestId: string,
  ): Promise<{ path: string; body: Record<string, unknown>; idem: string } | null> {
    const req = await this.stockRequests.findOne({
      where: { id: requestId },
      relations: { items: true },
    });
    if (!req) return null;
    if (req.status !== 'approved' && req.status !== 'received') {
      // Queued then rejected/cancelled before the drain ran. Nothing to send,
      // and nothing that will change — dead-letter rather than retry forever.
      throw new TerminalPayloadError(
        `Stock request ${req.requestNumber} is ${req.status}; only approved requests go to the ERP.`,
      );
    }

    const lines = req.items
      .filter((i) => Number(i.approvedBaseQty ?? 0) > 0)
      .map((i) => ({
        skuCode: i.itemNumber,
        label: i.itemName,
        requestedQty: Math.round(Number(i.baseQty) || 0),
        approvedQty: Math.round(Number(i.approvedBaseQty) || 0),
      }))
      .filter((l) => l.approvedQty > 0);
    if (!lines.length) {
      throw new TerminalPayloadError(
        `Stock request ${req.requestNumber} has no approved lines to send.`,
      );
    }

    const rep = req.repId ? await this.reps.findOne({ where: { id: req.repId } }) : null;

    return {
      path: 'van-stock-requests',
      idem: req.requestNumber,
      body: {
        externalId: req.id,
        requestNumber: req.requestNumber,
        vanWarehouseCode: req.vanStoreNumber,
        ...(req.sourceStoreNumber ? { sourceWarehouseCode: req.sourceStoreNumber } : {}),
        ...(rep?.code ? { repCode: rep.code } : {}),
        ...(rep?.nameAr ? { repName: rep.nameAr } : {}),
        ...(req.note ? { note: req.note } : {}),
        requestedAt: req.createdAt.toISOString(),
        ...(req.decidedAt ? { approvedAt: req.decidedAt.toISOString() } : {}),
        lines,
      },
    };
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
   * Companion receipt for the PAID portion of a split sale. The invoice itself was
   * pushed as CREDIT (buildSale → paymentType CREDIT); this settles the paid part,
   * allocated to the ERP invoice number resolved from the id-map (populated by
   * mapVoucher once the SALE_INVOICE posts — this row is only enqueued after that,
   * so the number is available). Carries its OWN idempotency key (`<voucher>-PAY`)
   * so it never collides with the sale's push. Returns null if the sale is no
   * longer a split (e.g. edited) — nothing to receipt.
   */
  private async buildSplitReceipt(
    voucherNumber: string,
  ): Promise<{ path: string; body: Record<string, unknown>; idem: string } | null> {
    const portion = await this.splitPaidPortion(voucherNumber);
    if (!portion) return null;
    const header = await this.headers.findOne({ where: { voucherNumber } });
    if (!header?.customerNumber) return null;
    const ref = await this.customerRef(header.customerNumber);
    if (!('customerId' in ref) && !('customerCode' in ref)) return null;
    // ERP invoice number for this sale (written by mapVoucher after it posted).
    const map = await this.idmap.findOne({
      where: { entity: 'voucher', localId: voucherNumber },
    });
    const invoiceNumber = map?.erpCode ?? undefined;
    const externalId = `${voucherNumber}-PAY`;
    return {
      path: 'receipts',
      idem: externalId,
      body: {
        externalId,
        ...ref,
        amount: portion.amount, // JOD major (voucher payments are stored in JOD)
        paymentMethod: portion.paymentMethod,
        ...(invoiceNumber ? { invoiceNumber } : {}),
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
    if (!header) throw new TerminalPayloadError('Order not found');

    // TERMINAL: the ERP's sales-orders endpoint requires a customer, and an
    // order that was saved without one will never acquire one by waiting.
    if (!header.customerNumber) {
      throw new TerminalPayloadError(
        'Order has no customer. The ERP cannot accept an order without one — ' +
          'raise it again against a customer.',
      );
    }

    // NOT terminal: the customer may still be mid-export. Returning null retries
    // with backoff, which is exactly right while the customer outbox drains.
    const cust = await this.idmap.findOne({
      where: { entity: 'customer', localId: header.customerNumber },
    });
    if (!cust?.erpId) return null;

    const lines = await this.lines.find({ where: { voucherNumber } });
    if (lines.length === 0) {
      throw new TerminalPayloadError('Order has no lines.');
    }
    const orderLines: Array<{
      skuId: string;
      quantity: number;
      sellingPrice: number;
      discountPercent: number;
    }> = [];
    for (const l of lines) {
      // Also not terminal — items mirror on the next catalogue sync.
      const sku = await this.idmap.findOne({ where: { entity: 'item', localId: l.itemNumber } });
      if (!sku?.erpId) return null;
      orderLines.push({
        skuId: sku.erpId,
        // Send the EXACT quantity — the ERP scales by QUANTITY_SCALE and accepts
        // decimals, so a 2.5-unit order must not be rounded to an integer here.
        quantity: Number(l.itemQty) || 0,
        // Carry the salesman's quoted price + discount (human units — the ERP
        // scales by MONEY_SCALE) so the sales order reflects what was offered,
        // not the ERP catalogue price.
        sellingPrice: Number(l.unitPrice) || 0,
        discountPercent: Number(l.discountPercentage) || 0,
      });
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

  /**
   * Classify a sale's payment for the ERP sales-invoice. A sale is PAID (the ERP
   * settles the invoice + posts a RECEIPT_VOUCHER + cash_receipt) when it has ≥1
   * non-CREDIT payment row and no CREDIT row; cheques count as paid (mapped to
   * CHECK). Otherwise the sale is on-account — send `paymentType: 'CREDIT'` so the
   * receivable stands and the credit limit is consumed. A split (paid + credit)
   * sale is treated as credit here; posting a companion receipt for the paid part
   * is a Phase-2 follow-up (see docs/SPEC-cash-sale-erp-export.md).
   */
  private async salePaymentFields(
    voucherNumber: string,
  ): Promise<{ paymentMethod?: string; paymentType: 'CASH' | 'CREDIT' }> {
    const rows = await this.payments.find({ where: { voucherNumber } });
    const paidRows = rows.filter((p) => p.paymentType !== 'CREDIT');
    const hasCredit = rows.some((p) => p.paymentType === 'CREDIT');

    // No money captured at the point of sale, or a credit portion exists → on-account.
    if (paidRows.length === 0 || hasCredit) return { paymentType: 'CREDIT' };

    // Fully paid: the ERP records ONE method for the full invoice total, so pick
    // the method carrying the most value.
    const byMethod = new Map<string, number>();
    for (const p of paidRows) {
      byMethod.set(p.paymentType, (byMethod.get(p.paymentType) ?? 0) + (Number(p.amount) || 0));
    }
    const dominant = [...byMethod.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { paymentMethod: ERP_PAYMENT_METHOD[dominant] ?? 'CASH', paymentType: 'CASH' };
  }

  /**
   * The PAID portion of a SPLIT (part-paid / part-credit) sale — its total paid
   * amount (JOD major) + the dominant method. Returns null when the sale is not a
   * split (fully paid, fully credit, or no payments), i.e. there is nothing to
   * settle with a companion receipt. A split = ≥1 non-CREDIT row AND a CREDIT row.
   */
  private async splitPaidPortion(
    voucherNumber: string,
  ): Promise<{ amount: number; paymentMethod: string } | null> {
    const rows = await this.payments.find({ where: { voucherNumber } });
    const paidRows = rows.filter((p) => p.paymentType !== 'CREDIT');
    const hasCredit = rows.some((p) => p.paymentType === 'CREDIT');
    if (paidRows.length === 0 || !hasCredit) return null;

    const byMethod = new Map<string, number>();
    let amount = 0;
    for (const p of paidRows) {
      const v = Number(p.amount) || 0;
      amount += v;
      byMethod.set(p.paymentType, (byMethod.get(p.paymentType) ?? 0) + v);
    }
    if (amount <= 0) return null;
    const dominant = [...byMethod.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { amount, paymentMethod: ERP_PAYMENT_METHOD[dominant] ?? 'CASH' };
  }

  /**
   * Quantity in the shape the ERP accepts: `z.number().int().positive()`.
   *
   * Van lines are `numeric(14,3)`, so a fractional or zero quantity is storable
   * here but rejected outright by the ERP. Rounding it would silently desync the
   * two systems' totals — the van's invoice and the ERP's would disagree on what
   * was sold — so this throws instead, naming the item. pushOne turns that into a
   * failed outbox row whose `error` says exactly what to fix, rather than the
   * opaque "HTTP 400" the ERP would otherwise return.
   */
  private erpQty(raw: unknown, itemNumber: string, voucherNumber: string): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(
        `${voucherNumber}: item ${itemNumber} has quantity "${String(raw)}" — the ERP requires a positive quantity`,
      );
    }
    if (!Number.isInteger(n)) {
      throw new Error(
        `${voucherNumber}: item ${itemNumber} has fractional quantity ${n} — the ERP only accepts whole units, and rounding would desync the invoice totals`,
      );
    }
    return n;
  }

  /**
   * The ERP SKU each line of ONE voucher posts against: the VARIANT's own SKU
   * when the line was entered in a unit that has one, else the item's base SKU
   * (`item_number`, which is the base SKU by construction).
   *
   * Without this a red sale posted against the base SKU and the ERP's own
   * per-colour stock diverged from the van's on the very first sale (spec §5.3).
   *
   * Resolved for the whole voucher in ONE query — a lookup per line is an N+1 on
   * a path that runs for every document the van pushes. A voucher whose lines
   * carry no unit at all skips the query entirely.
   */
  private async erpSkuResolver(
    lines: VoucherTransaction[],
  ): Promise<(line: VoucherTransaction) => string> {
    const unitIds = [
      ...new Set(lines.map((l) => l.itemUnitId).filter((id): id is string => !!id)),
    ];
    if (unitIds.length === 0) return (l) => l.itemNumber;
    const units = await this.itemUnits.find({ where: { id: In(unitIds) } });
    const skuByUnit = new Map(
      units.filter((u) => u.erpSkuCode).map((u) => [u.id, u.erpSkuCode!]),
    );
    // A unit with no erp_sku_code was authored in the dashboard, not synced —
    // the ERP has never heard of it, so its line falls back to the base SKU.
    return (l) => (l.itemUnitId ? skuByUnit.get(l.itemUnitId) : undefined) ?? l.itemNumber;
  }

  private async buildSale(
    voucherNumber: string,
  ): Promise<{ path: string; body: Record<string, unknown> } | null> {
    const header = await this.headers.findOne({ where: { voucherNumber } });
    if (!header) return null;
    const lines = await this.lines.find({ where: { voucherNumber } });
    const skuOf = await this.erpSkuResolver(lines);
    const items = await Promise.all(
      lines.map(async (l) => {
        // quantity is in BASE pieces (item_qty), so send the per-PIECE price.
        // For base-unit lines (unit_base_qty = 1) this equals unit_price exactly
        // — and a variant's divisor is 1 too, since a colour is one piece.
        const baseQty = l.unitBaseQty && l.unitBaseQty > 0 ? l.unitBaseQty : 1;
        const base = {
          skuCode: skuOf(l), // the variant's SKU, else the item's base SKU
          quantity: this.erpQty(l.itemQty, l.itemNumber, voucherNumber),
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
    // Cash/cheque/card/transfer sales carry paymentMethod so the ERP settles the
    // invoice (records the payment + RECEIPT_VOUCHER journal); credit sales send
    // paymentType CREDIT and stay as a receivable. Without this the ERP booked
    // EVERY van sale as credit. (docs/SPEC-cash-sale-erp-export.md)
    const payment = await this.salePaymentFields(voucherNumber);
    return {
      path: 'sales-invoices',
      body: {
        externalId: voucherNumber,
        deviceId: header.userCode,
        ...(await this.customerRef(header.customerNumber)),
        warehouseCode: this.vanStoreOf(lines, header.userCode), // attribute to the van
        invoiceDate: header.inDate,
        ...payment,
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
    if (!ref) {
      throw new TerminalPayloadError(
        'Return has no source sale. Re-raise it through Return-by-item so it can ' +
          'be matched to the sales it came from.',
      );
    }
    const map = await this.idmap.findOne({ where: { entity: 'voucher', localId: ref } });
    const originalInvoiceNumber = map?.erpCode ?? ref;
    const lines = await this.lines.find({ where: { voucherNumber } });
    const skuOf = await this.erpSkuResolver(lines);
    return {
      path: 'sales-returns',
      body: {
        externalId: voucherNumber,
        deviceId: header.userCode,
        ...(await this.customerRef(header.customerNumber)),
        warehouseCode: this.vanStoreOf(lines, header.userCode), // physical return to the van
        originalInvoiceNumber,
        lines: lines.map((l) => ({
          skuCode: skuOf(l), // red goes back to the red SKU, not the base one
          quantity: this.erpQty(l.itemQty, l.itemNumber, voucherNumber),
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
    const skuOf = await this.erpSkuResolver(lines);
    return {
      path: 'stock-adjustments',
      body: {
        externalId: voucherNumber,
        deviceId: header.userCode,
        warehouseCode: this.vanStoreOf(lines, header.userCode),
        type: header.transKind === 'IN' ? 'IN' : 'OUT',
        items: lines.map((l) => ({
          skuCode: skuOf(l),
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
    const skuOf = await this.erpSkuResolver(lines);
    const items = lines.map((l) => ({
      skuCode: skuOf(l),
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

  /**
   * The ERP's GL outcome for a pushed document.
   *
   * Both fields are documented on the sales-invoice response only, so a missing
   * `journalId` elsewhere means "not reported", never "not posted" — which is
   * why `warnOnPostingGap` restricts its alarm to SALE_INVOICE.
   */
  private extractPostingInfo(data: unknown): {
    journalId: string | null;
    paymentSkipped: boolean;
  } {
    if (!data || typeof data !== 'object') {
      return { journalId: null, paymentSkipped: false };
    }
    const top = data as Record<string, unknown>;
    const d = (top.data as Record<string, unknown> | undefined) ?? top;
    return {
      journalId: typeof d?.journalId === 'string' ? d.journalId : null,
      paymentSkipped: d?.paymentSkipped === true,
    };
  }

  /**
   * Surface the two silent failure modes the ERP deliberately does not raise as
   * errors. Neither is retryable — both need a human to fix ERP configuration —
   * so this logs rather than failing the row, which is already `posted`.
   */
  private warnOnPostingGap(row: ErpOutbox): void {
    if (row.kind !== 'SALE_INVOICE') return;
    if (!row.journalId) {
      this.logger.warn(
        `Sale ${row.ref} (ERP ${row.resultRef ?? '?'}) posted with NO GL journal. ` +
          'The invoice and stock committed, but nothing reached the ledger — the ' +
          'org likely has no payment-method account mapped ' +
          '(PAYMENT_METHOD_ACCOUNT_NOT_CONFIGURED). Fix it in the ERP under ' +
          'Settings → Finance → Payment Method Accounts. Do NOT re-push.',
      );
    }
    if (row.paymentSkipped) {
      this.logger.warn(
        `Sale ${row.ref} (ERP ${row.resultRef ?? '?'}) was booked as CREDIT: the ERP ` +
          'refused the inline payment, most likely an approval workflow. Cash was ' +
          'collected in the van but is not in the ERP books.',
      );
    }
  }

  private extractResultRef(data: unknown): string | null {
    if (data && typeof data === 'object') {
      const top = data as Record<string, unknown>;
      // Success: the ERP document, wrapped as { data: {...} }.
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
