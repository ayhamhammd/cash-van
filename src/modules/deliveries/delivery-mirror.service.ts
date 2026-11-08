import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { toFils } from '../erp-sync/erp-sync.service';
import { ErpSyncCursor } from '../erp-sync/entities/erp-sync-cursor.entity';
import { DeliveryErpClient } from './delivery-erp.client';
import { DeliveryRun, type DeliveryRunStatus } from './entities/delivery-run.entity';
import {
  DeliveryStop,
  type DeliveryReturnStatus,
  type DeliveryStopStatus,
} from './entities/delivery-stop.entity';
import { conditionOf } from './delivery-reasons';
import { DeliveryStopLine } from './entities/delivery-stop-line.entity';
import type {
  ErpDeliveryItem,
  ErpDeliveryLine,
  ErpDeliveryRun,
  ErpLineResult,
} from './erp-delivery.types';

// Read from process.env: @Interval() is evaluated at class-definition time,
// before DI — the same constraint ERP_PULL_INTERVAL_MS documents.
const DELIVERY_PULL_MS = parseInt(process.env.DELIVERY_PULL_INTERVAL_MS ?? '120000', 10);

/** The erp_sync_cursor row this pull keeps its high-water mark in. */
export const DELIVERY_CURSOR = 'delivery_runs';

const STOP_STATUSES = new Set<DeliveryStopStatus>(['LOADED', 'DELIVERED', 'PARTIAL', 'RETURNED']);
const RETURN_STATUSES = new Set<DeliveryReturnStatus>(['NONE', 'PENDING', 'APPROVED', 'REJECTED']);

/** What one apply did, for the caller and for the signal. */
export interface ApplyRunResult {
  runId: string;
  repId: string | null;
  previousRepId: string | null;
  runChanged: boolean;
  changedStopIds: string[];
  removedStopIds: string[];
}

/**
 * Copy `patch` onto `target`, reporting whether any value actually changed.
 *
 * Values are compared as the database hands them back: numeric columns arrive
 * as strings ('31.95'), timestamps as Dates. `numeric` names the keys compared
 * by value, so '31.950' and 31.95 are the same latitude while a text column like
 * an invoice number is still compared as text.
 */
export function assignChanged<T extends object>(
  target: T,
  patch: Partial<T>,
  numeric: ReadonlyArray<keyof T> = [],
): boolean {
  let changed = false;
  for (const [k, next] of Object.entries(patch) as Array<[keyof T, unknown]>) {
    const prev = target[k] as unknown;
    if (prev === undefined) (target as Record<keyof T, unknown>)[k] = next ?? null;
    if (!sameValue(prev, next, numeric.includes(k))) {
      (target as Record<keyof T, unknown>)[k] = next;
      changed = true;
    }
  }
  return changed;
}

function sameValue(a: unknown, b: unknown, numeric: boolean): boolean {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (na === null || nb === null) return na === nb;
  if (na instanceof Date || nb instanceof Date) {
    const ta = na instanceof Date ? na.getTime() : new Date(String(na)).getTime();
    const tb = nb instanceof Date ? nb.getTime() : new Date(String(nb)).getTime();
    return ta === tb;
  }
  if (numeric) return Number(na) === Number(nb);
  return String(na) === String(nb);
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function date(v: unknown): Date | null {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : null;
}

/**
 * The run's calendar day, YYYY-MM-DD. The ERP sends a plain date; a full
 * timestamp is read as the day it falls on in Amman, not in UTC, so a run dated
 * midnight local time is not filed under the day before.
 */
export function runDay(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = date(s);
  if (!d) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.DELIVERY_TZ ?? 'Asia/Amman',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * The read mirror of the ERP's delivery runs (docs/SPEC-delivery-rep.md §5).
 *
 * The ERP owns the run (R1). This writes `delivery_runs`, `delivery_stops` and
 * `delivery_stop_lines` from what the ERP says, and nothing else writes their
 * ERP columns. The one thing kept that the ERP does not know yet is a phone's
 * result in flight (`local_result_ref`): it survives the pull, and it is what
 * stops a delivered stop being deleted because the office removed it from the
 * run before the result arrived.
 *
 * Every apply that changes something emits `delivery.changed`, which the event
 * bridge turns into `delivery.updated` for dashboards and `sync.required
 * {deliveries}` for the rep (and the previous rep, when the run moved).
 */
@Injectable()
export class DeliveryMirrorService {
  private readonly logger = new Logger(DeliveryMirrorService.name);
  private pulling = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly erp: DeliveryErpClient,
    @InjectRepository(ErpSyncCursor) private readonly cursors: Repository<ErpSyncCursor>,
    private readonly events: EventEmitter2,
  ) {}

  /** Every 2 minutes (DELIVERY_PULL_INTERVAL_MS), when ERP sync is on. */
  @Interval(DELIVERY_PULL_MS)
  async scheduledPull(): Promise<void> {
    if (this.pulling) return;
    if (!(await this.erp.isEnabled())) return;
    await this.pullDeliveryRuns().catch((e: unknown) =>
      this.logger.warn(`delivery-runs pull failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  /**
   * Read every run the ERP changed since the cursor and mirror it.
   *
   * THE CURSOR IS OPAQUE. The ERP's `updatedAt` is its database's local
   * wall-clock time (Asia/Amman) written with a trailing Z, so parsing it into a
   * Date and serialising it back would shift it by the UTC offset and skip — or
   * re-read — three hours of changes. It is stored exactly as received, in
   * `erp_sync_cursor.resume_key`, and sent back unchanged. `updatedSince` is
   * inclusive on the ERP, so the last run is read again each time; the upsert
   * is idempotent, and that overlap is what makes the feed lossless.
   *
   * The cursor never moves past a run that failed to apply: the ERP answers in
   * updatedAt order, so it stops at the last run before the first failure and
   * the next pull reads from there (the runs after it are applied now and again
   * then, which is harmless).
   *
   * Never runs twice at once; a second call while one is in flight returns 0.
   */
  async pullDeliveryRuns(): Promise<number> {
    if (this.pulling) return 0;
    this.pulling = true;
    const started = Date.now();
    const cursor =
      (await this.cursors.findOne({ where: { entity: DELIVERY_CURSOR } })) ??
      this.cursors.create({ entity: DELIVERY_CURSOR });
    try {
      const since = cursor.resumeKey ?? undefined;
      const runs = await this.erp.listRunsSince(since);
      let next: string | null = cursor.resumeKey ?? null;
      let blocked = false;
      let applied = 0;
      let failed = 0;
      for (const run of runs) {
        try {
          await this.applyRun(run);
          applied += 1;
          // In ERP order, so the last one applied is the highest; kept verbatim.
          if (!blocked && run.updatedAt) next = String(run.updatedAt);
        } catch (e) {
          failed += 1;
          blocked = true;
          this.logger.warn(
            `delivery run ${run.id} not mirrored: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      cursor.resumeKey = next;
      cursor.lastRunAt = new Date();
      cursor.lastStatus = failed ? 'failed' : 'ok';
      cursor.lastCount = applied;
      cursor.lastSkipped = failed;
      cursor.durationMs = Date.now() - started;
      cursor.lastError = failed ? `${failed} run(s) could not be mirrored; see the server log` : null;
      await this.cursors.save(cursor);
      return applied;
    } catch (e) {
      cursor.lastRunAt = new Date();
      cursor.lastStatus = 'failed';
      cursor.durationMs = Date.now() - started;
      cursor.lastError = e instanceof Error ? e.message : String(e);
      await this.cursors.save(cursor).catch(() => undefined);
      throw e;
    } finally {
      this.pulling = false;
    }
  }

  /**
   * Re-read one run from the ERP and mirror it — what a dashboard write does
   * after the ERP accepted it, and what a terminal outbox refusal does to show
   * the ERP's truth. A run the ERP no longer has is removed (stops with a result
   * in flight are kept).
   */
  async pullRun(erpId: string, opts: { settledRef?: string } = {}): Promise<ApplyRunResult | null> {
    const run = await this.erp.getRun(erpId);
    if (run) return this.applyRun(run, opts);
    await this.removeRun(erpId);
    return null;
  }

  /**
   * Mirror one ERP run: upsert the run, its stops and their lines; delete stops
   * the ERP no longer has unless a result for them is in flight.
   *
   * `settledRef` is a phone clientRef the ERP has just answered: the stop
   * holding it stops being SENDING whatever the run says. The pull settles a
   * stop on its own as soon as the ERP reports that same ref as the item's
   * `resultExternalRef`.
   *
   * A reply older than the version already mirrored (by ERP updatedAt) changes
   * nothing but that settlement — two answers racing must not let the stale one
   * win.
   */
  async applyRun(run: ErpDeliveryRun, opts: { settledRef?: string } = {}): Promise<ApplyRunResult> {
    const erpId = String(run.id);
    const result = await this.dataSource.transaction((em) => this.applyWithin(em, erpId, run, opts));
    this.signal(result, 'erp.pull');
    return result;
  }

  /** Clear an in-flight ref the ERP has answered, wherever it sits. Returns the stop. */
  async settleRef(clientRef: string): Promise<DeliveryStop | null> {
    const repo = this.dataSource.getRepository(DeliveryStop);
    const stop = await repo.findOne({ where: { localResultRef: clientRef } });
    if (!stop) return null;
    await repo.update({ id: stop.id }, { localResultRef: null });
    const run = await this.dataSource.getRepository(DeliveryRun).findOne({ where: { id: stop.runId } });
    this.signal(
      {
        runId: stop.runId,
        repId: run?.repId ?? null,
        previousRepId: run?.repId ?? null,
        runChanged: false,
        changedStopIds: [stop.id],
        removedStopIds: [],
      },
      'delivery.settled',
    );
    return stop;
  }

  /** Tell dashboards and the rep(s) that a run changed. No-op when nothing did. */
  signal(r: ApplyRunResult, reason: string): void {
    if (!r.runChanged && !r.changedStopIds.length && !r.removedStopIds.length) return;
    const single =
      !r.runChanged && r.changedStopIds.length + r.removedStopIds.length === 1
        ? (r.changedStopIds[0] ?? r.removedStopIds[0])
        : undefined;
    this.events.emit('delivery.changed', {
      runId: r.runId,
      ...(single ? { stopId: single } : {}),
      repId: r.repId,
      previousRepId: r.previousRepId,
      reason,
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async applyWithin(
    em: EntityManager,
    erpId: string,
    run: ErpDeliveryRun,
    opts: { settledRef?: string },
  ): Promise<ApplyRunResult> {
    // One writer per run: the pull, a dashboard write and an outbox reply can
    // all land on the same run at the same moment.
    await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`delivery_run:${erpId}`]);
    const runs = em.getRepository(DeliveryRun);
    const stops = em.getRepository(DeliveryStop);

    let row = await runs.findOne({ where: { erpId } });
    const incomingTs = date(run.updatedAt);
    const previousRepId = row?.repId ?? null;

    if (row && row.erpUpdatedAt && incomingTs && incomingTs < row.erpUpdatedAt) {
      const changedStopIds: string[] = [];
      if (opts.settledRef) {
        const s = await stops.findOne({ where: { runId: row.id, localResultRef: opts.settledRef } });
        if (s) {
          await stops.update({ id: s.id }, { localResultRef: null });
          changedStopIds.push(s.id);
        }
      }
      return {
        runId: row.id,
        repId: row.repId ?? null,
        previousRepId,
        runChanged: false,
        changedStopIds,
        removedStopIds: [],
      };
    }

    const driverCode = str(run.driver?.salesmanCode);
    const repId = await this.repIdFor(em, driverCode);
    const isNew = !row;
    row ??= runs.create({ erpId });
    const status: DeliveryRunStatus = String(run.status ?? '').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
    const runChanged =
      assignChanged(row, {
        runNumber: str(run.runNumber),
        repId,
        driverCode,
        driverName: str(run.driver?.name),
        vehicleErpId: str(run.vehicle?.id),
        vehicleName: str(run.vehicle?.name),
        vehiclePlate: str(run.vehicle?.plateNumber),
        runDate: runDay(run.runDate),
        status,
        notes: str(run.notes),
        openedAt: date(run.openedAt),
        closedAt: date(run.closedAt),
      }) || isNew;
    // Not a change anyone needs telling about, but the guard above reads it.
    // The ERP's value is local time marked Z (see pullDeliveryRuns), so this
    // column is shifted by the UTC offset — fine for ordering two versions of
    // the same run, which is all it is used for.
    row.erpUpdatedAt = incomingTs ?? row.erpUpdatedAt ?? null;
    row.syncedAt = new Date();
    row = await runs.save(row);
    const runId = row.id;

    const existing = await stops.find({ where: { runId } });
    const byErp = new Map(existing.map((s) => [s.erpId, s]));
    const seen = new Set<string>();
    const changedStopIds: string[] = [];

    for (const item of run.items ?? []) {
      if (!item || item.id === undefined || item.id === null) continue;
      const itemId = String(item.id);
      seen.add(itemId);
      const known = byErp.get(itemId) ?? (await stops.findOne({ where: { erpId: itemId } }));
      const stop = known ?? stops.create({ erpId: itemId, runId });
      let changed = !known;
      changed = this.patchStop(stop, runId, item, await this.customerIdFor(em, item)) || changed;
      changed =
        assignChanged(stop, {
          erpOnlyAttachments: await this.erpOnlyAttachments(em, known?.id ?? null, item),
        }, ['erpOnlyAttachments']) || changed;
      const ref = stop.localResultRef;
      if (ref && (ref === str(item.resultExternalRef) || ref === opts.settledRef)) {
        stop.localResultRef = null;
        changed = true;
      }
      const saved = changed ? await stops.save(stop) : stop;
      const linesChanged = await this.applyLines(em, saved.id, item.invoice?.lines ?? [], {
        status: saved.status,
        results: item.results ?? null,
      });
      if (changed || linesChanged) changedStopIds.push(saved.id);
    }

    const removedStopIds: string[] = [];
    for (const s of existing) {
      if (seen.has(s.erpId)) continue;
      // A result for it is on its way to the ERP: keep it until the ERP has
      // answered, so a delivery that really happened is not lost.
      if (s.localResultRef) continue;
      await stops.delete({ id: s.id });
      removedStopIds.push(s.id);
    }

    return {
      runId,
      repId: row.repId ?? null,
      previousRepId: isNew ? null : previousRepId,
      runChanged,
      changedStopIds,
      removedStopIds,
    };
  }

  /** The ERP's view of one stop onto the mirror row. True when anything changed. */
  private patchStop(
    stop: DeliveryStop,
    runId: string,
    item: ErpDeliveryItem,
    customerId: string | null,
  ): boolean {
    const inv = item.invoice ?? {};
    const rawStatus = String(item.status ?? 'LOADED').toUpperCase() as DeliveryStopStatus;
    const rawReturn = String(item.returnStatus ?? 'NONE').toUpperCase() as DeliveryReturnStatus;
    return assignChanged(
      stop,
      {
        runId,
        sequence: Number.isFinite(Number(item.sequence)) ? Number(item.sequence) : 0,
        erpInvoiceId: str(inv.id),
        invoiceNumber: str(inv.invoiceNumber),
        invoiceDate: date(inv.issueDate),
        customerId,
        erpCustomerId: str(inv.customerId),
        customerCode: str(inv.customerCode),
        recipientName: str(inv.customerName),
        recipientPhone: str(inv.customerPhone),
        address: str(inv.customerAddress),
        // Major units → fils, exactly as erp-sync mirrors sales-invoices.
        totalFils: String(toFils(inv.totalAmount)),
        taxFils: String(toFils(inv.taxAmount)),
        paidFils: String(toFils(inv.amountPaid)),
        paymentType: str(inv.paymentType),
        jofotaraStatus: str(inv.jofotaraStatus),
        jofotaraQr: str(inv.jofotaraQrCode),
        jofotaraUuid: str(inv.jofotaraUuid),
        status: STOP_STATUSES.has(rawStatus) ? rawStatus : 'LOADED',
        returnStatus: RETURN_STATUSES.has(rawReturn) ? rawReturn : 'NONE',
        deliveredAt: date(item.deliveredAt),
        signedByName: str(item.signedByName),
        lat: num(item.deliveredLat),
        lng: num(item.deliveredLng),
        resultSource: str(item.resultSource),
        resultExternalRef: str(item.resultExternalRef),
      },
      ['sequence', 'totalFils', 'taxFils', 'paidFils', 'lat', 'lng'],
    );
  }

  /**
   * Upsert a stop's lines by ERP line id; drop the ones the ERP no longer has.
   *
   * The invoiced quantity is the invoice line's quantity less what was already
   * returned on it. The result side comes from the ERP's item `results`, which
   * lists only the lines that differ: a line it does not list was delivered in
   * full. Two exceptions: a stop still LOADED has no result at all, and a
   * RETURNED stop with no line rows (a whole refusal, or one recorded before
   * the ERP kept line rows) delivered nothing.
   */
  private async applyLines(
    em: EntityManager,
    stopId: string,
    lines: ErpDeliveryLine[],
    ctx: { status: DeliveryStopStatus; results: ErpLineResult[] | null } = {
      status: 'LOADED',
      results: null,
    },
  ): Promise<boolean> {
    const results = new Map(
      (ctx.results ?? [])
        .filter((r) => r && r.invoiceItemId !== undefined && r.invoiceItemId !== null)
        .map((r) => [String(r.invoiceItemId), r]),
    );
    const wholeRefusal = ctx.status === 'RETURNED' && results.size === 0;
    const repo = em.getRepository(DeliveryStopLine);
    const existing = await repo.find({ where: { stopId } });
    const byItem = new Map(existing.map((l) => [l.erpInvoiceItemId, l]));
    const seen = new Set<string>();
    let changed = false;
    for (const l of lines) {
      if (!l || l.id === undefined || l.id === null) continue;
      const itemId = String(l.id);
      seen.add(itemId);
      const known = byItem.get(itemId);
      const line = known ?? repo.create({ stopId, erpInvoiceItemId: itemId });
      const invoiced = Math.max(0, (Number(l.quantity) || 0) - (Number(l.quantityReturned) || 0));
      const r = results.get(itemId);
      const outcome =
        ctx.status === 'LOADED'
          ? { deliveredQty: null, reasonCode: null, condition: null, note: null, approvedQty: null }
          : r
            ? {
                deliveredQty: num(r.deliveredQty),
                reasonCode: str(r.reasonCode),
                condition: str(r.condition) ?? conditionOf(r.reasonCode),
                note: str(r.note),
                approvedQty: num(r.approvedQty),
              }
            : {
                deliveredQty: wholeRefusal ? '0' : String(invoiced),
                reasonCode: null,
                condition: null,
                note: null,
                approvedQty: null,
              };
      const diff = assignChanged(
        line,
        {
          lineNo: Number.isFinite(Number(l.lineNo)) && l.lineNo !== null ? Number(l.lineNo) : null,
          skuCode: str(l.skuCode),
          // The ERP keeps one catalogue name, in nameEn; nameAr is always null
          // there. Show that name rather than nothing.
          nameAr: str(l.nameAr) ?? str(l.nameEn),
          nameEn: str(l.nameEn),
          unit: str(l.unit),
          invoicedQty: String(invoiced),
          unitPriceFils: String(toFils(l.unitPrice)),
          taxRate: num(l.taxRate),
          ...outcome,
        },
        ['lineNo', 'invoicedQty', 'unitPriceFils', 'taxRate', 'deliveredQty', 'approvedQty'],
      );
      if (!known || diff) {
        await repo.save(line);
        changed = true;
      }
    }
    const gone = existing.filter((l) => !seen.has(l.erpInvoiceItemId));
    if (gone.length) {
      await repo.delete(gone.map((l) => l.id));
      changed = true;
    }
    return changed;
  }

  /**
   * How many of the ERP item's attachments are not one of our proofs — one
   * uploaded in the ERP's own screen. Counted, never mirrored: the files the
   * dashboard and the phone show are this server's own copies.
   */
  private async erpOnlyAttachments(
    em: EntityManager,
    stopId: string | null,
    item: ErpDeliveryItem,
  ): Promise<number> {
    const ids = (item.attachments ?? [])
      .map((a) => (a && a.id !== undefined && a.id !== null ? String(a.id) : null))
      .filter((x): x is string => !!x);
    if (!ids.length) return 0;
    if (!stopId) return ids.length;
    const ours: Array<{ erp_attachment_id: string }> = await em.query(
      `SELECT erp_attachment_id FROM delivery_proofs
        WHERE stop_id = $1 AND erp_attachment_id = ANY($2::text[])`,
      [stopId, ids],
    );
    const known = new Set(ours.map((o) => o.erp_attachment_id));
    return ids.filter((id) => !known.has(id)).length;
  }

  /** Driver salesmanCode → reps.code (R7: van code = salesman code). */
  private async repIdFor(em: EntityManager, code: string | null): Promise<string | null> {
    if (!code) return null;
    const rows: Array<{ id: string }> = await em.query(
      `SELECT id FROM reps WHERE code = $1 AND deleted_at IS NULL LIMIT 1`,
      [code],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * The local customer of an invoice: its code is a customer_number here; an
   * ERP-origin customer whose number was derived (`ERP-…`) is found through the
   * id map instead, the way the invoice mirror finds it.
   */
  private async customerIdFor(em: EntityManager, item: ErpDeliveryItem): Promise<string | null> {
    const code = str(item.invoice?.customerCode);
    if (code) {
      const rows: Array<{ id: string }> = await em.query(
        `SELECT id FROM customers WHERE customer_number = $1 AND deleted_at IS NULL LIMIT 1`,
        [code],
      );
      if (rows[0]) return rows[0].id;
    }
    const erpCustomerId = str(item.invoice?.customerId);
    if (erpCustomerId) {
      const rows: Array<{ id: string }> = await em.query(
        `SELECT c.id
           FROM erp_id_map m
           JOIN customers c ON c.customer_number = m.local_id AND c.deleted_at IS NULL
          WHERE m.entity = 'customer' AND m.erp_id = $1
          LIMIT 1`,
        [erpCustomerId],
      );
      if (rows[0]) return rows[0].id;
    }
    return null;
  }

  /** The ERP no longer has this run: drop it, keeping only stops with a result in flight. */
  private async removeRun(erpId: string): Promise<void> {
    const result = await this.dataSource.transaction(async (em) => {
      await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`delivery_run:${erpId}`]);
      const run = await em.getRepository(DeliveryRun).findOne({ where: { erpId } });
      if (!run) return null;
      const stops = await em.getRepository(DeliveryStop).find({ where: { runId: run.id } });
      if (stops.some((s) => s.localResultRef)) {
        const gone = stops.filter((s) => !s.localResultRef);
        if (gone.length) await em.getRepository(DeliveryStop).delete(gone.map((s) => s.id));
        return { run, removed: gone.map((s) => s.id) };
      }
      await em.getRepository(DeliveryRun).delete({ id: run.id });
      return { run, removed: stops.map((s) => s.id) };
    });
    if (result) {
      this.signal(
        {
          runId: result.run.id,
          repId: result.run.repId ?? null,
          previousRepId: result.run.repId ?? null,
          runChanged: true,
          changedStopIds: [],
          removedStopIds: result.removed,
        },
        'erp.run.removed',
      );
    }
  }
}
