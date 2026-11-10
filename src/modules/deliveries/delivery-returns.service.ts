import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';

import { toFils } from '../erp-sync/erp-sync.service';
import { Rep } from '../reps/entities/rep.entity';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { DeliveriesService } from './deliveries.service';
import { DeliveryErpClient } from './delivery-erp.client';
import { DeliveryMirrorService } from './delivery-mirror.service';
import { DeliveryReturnVoucherService } from './delivery-return-voucher.service';
import { DeliveryRun } from './entities/delivery-run.entity';
import { DeliveryStop } from './entities/delivery-stop.entity';
import { DeliveryStopLine } from './entities/delivery-stop-line.entity';
import type { ErpCreditNote } from './erp-delivery.types';
import {
  returnRequestView,
  type RepRef,
  type ReturnRequestView,
  type StopView,
} from './delivery-views';
import type { ApproveReturnDto, ListReturnsQuery, RejectReturnDto } from './dto/deliveries.dto';

/** When a stop was finished — the same rule the phone's lists use. */
const FINISHED_AT = 'COALESCE(s.delivered_at, s.local_delivered_at, s.updated_at)';

export interface CreditNoteSummary {
  number: string | null;
  totalFils: number;
  jofotaraStatus: string | null;
  qr: string | null;
}

/** The ERP's credit note, in this API's shape (fils). */
export function creditNoteSummary(cn: ErpCreditNote | null | undefined): CreditNoteSummary | null {
  if (!cn) return null;
  return {
    number: cn.number ?? null,
    totalFils: toFils(cn.total),
    jofotaraStatus: cn.jofotara?.status ?? null,
    qr: cn.jofotara?.qrCode ?? null,
  };
}

/**
 * Delivery returns (docs/SPEC-delivery-rep.md §6.2, phase-3 contract §B).
 *
 * The queue is read from the mirror. A decision is made in ONE place, the ERP
 * (R3): approve and reject call it live, with the office user as the decider
 * and the dashboard's Idempotency-Key passed through, then the run is re-read
 * so the mirror — and through it the rep's notification, his phone and every
 * dashboard — carry the decision. A return is customer credit only; nothing
 * here touches the rep's cash (R4).
 */
@Injectable()
export class DeliveryReturnsService {
  private readonly logger = new Logger(DeliveryReturnsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(DeliveryStop) private readonly stops: Repository<DeliveryStop>,
    @InjectRepository(DeliveryRun) private readonly runs: Repository<DeliveryRun>,
    @InjectRepository(DeliveryStopLine) private readonly lines: Repository<DeliveryStopLine>,
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
    private readonly deliveries: DeliveriesService,
    private readonly erp: DeliveryErpClient,
    private readonly mirror: DeliveryMirrorService,
    // APPENDED: the specs build this service positionally.
    @Optional() private readonly returnVouchers?: DeliveryReturnVoucherService,
  ) {}

  /**
   * The queue. PENDING (default) oldest first; DECIDED newest decision first;
   * ALL every stop that ever had a return. A result still on its way to the
   * ERP is not listed: the ERP cannot decide what it has not received.
   */
  async list(q: ListReturnsQuery): Promise<{ items: ReturnRequestView[]; total: number }> {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const status = q.status ?? 'PENDING';
    const params: unknown[] = [];
    const p = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = ['s.local_result_ref IS NULL'];
    if (status === 'PENDING') where.push(`s.return_status = 'PENDING'`);
    else if (status === 'DECIDED') where.push(`s.return_status IN ('APPROVED', 'REJECTED')`);
    else where.push(`s.return_status <> 'NONE'`);
    if (q.repId) where.push(`r.rep_id = ${p(q.repId)}`);
    if (q.customerId) where.push(`s.customer_id = ${p(q.customerId)}`);
    if (q.from || q.to) {
      const tz = p(await this.timezone());
      if (q.from) where.push(`(${FINISHED_AT} AT TIME ZONE ${tz})::date >= ${p(q.from)}::date`);
      if (q.to) where.push(`(${FINISHED_AT} AT TIME ZONE ${tz})::date <= ${p(q.to)}::date`);
    }
    const rows: Array<{ id: string; total: string }> = await this.dataSource.query(
      `SELECT s.id, count(*) OVER () AS total
         FROM delivery_stops s
         JOIN delivery_runs r ON r.id = s.run_id
        WHERE ${where.join(' AND ')}
        ORDER BY (s.return_status = 'PENDING') DESC,
                 CASE WHEN s.return_status = 'PENDING' THEN ${FINISHED_AT} END ASC,
                 s.return_decided_at DESC NULLS LAST,
                 s.id
        LIMIT ${p(pageSize)} OFFSET ${p((page - 1) * pageSize)}`,
      params,
    );
    if (!rows.length) return { items: [], total: 0 };
    const items = await this.requests(rows.map((r) => r.id));
    return { items, total: Number(rows[0].total) };
  }

  /** `{ pending }` for the sidebar badge. */
  async count(): Promise<{ pending: number }> {
    const rows: Array<{ n: number }> = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM delivery_stops
        WHERE return_status = 'PENDING' AND local_result_ref IS NULL`,
    );
    return { pending: rows[0]?.n ?? 0 };
  }

  /** Approve on the ERP (it issues the credit note), re-read the run, answer from the mirror. */
  async approve(
    stopId: string,
    dto: ApproveReturnDto,
    actor: AuthenticatedUser,
    idempotencyKey?: string,
  ): Promise<{
    stop: StopView;
    creditNote: CreditNoteSummary | null;
    returnVoucher: { id: string; voucherNumber: string } | null;
  }> {
    const { stop, run } = await this.stopAndRun(stopId);
    const { creditNote } = await this.erp.approveReturn(
      stop.erpId,
      {
        approvedBy: await this.decider(actor),
        ...(dto.note?.trim() ? { note: dto.note.trim() } : {}),
        ...(dto.lines?.length
          ? {
              lines: dto.lines.map((l) => ({
                invoiceItemId: l.erpInvoiceItemId,
                qty: l.qty,
                condition: l.condition,
              })),
            }
          : {}),
      },
      this.key(idempotencyKey),
    );
    await this.remirror(run.erpId);
    // The CashVan RETURN voucher (once — the mirror may already have made it).
    const rv = await this.returnVouchers?.ensureFor(stop.id).catch((e: unknown) => {
      this.logger.warn(`RETURN voucher for stop ${stop.id}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    const fresh = await this.freshStop(stop.id);
    return {
      stop: fresh.view,
      returnVoucher:
        rv && 'voucherNumber' in rv ? { id: rv.voucherId, voucherNumber: rv.voucherNumber } : null,
      creditNote:
        creditNoteSummary(creditNote) ??
        (fresh.stop.creditNoteNumber
          ? {
              number: fresh.stop.creditNoteNumber,
              totalFils: Number(fresh.stop.creditNoteTotalFils ?? 0),
              jofotaraStatus: fresh.stop.creditNoteJofotaraStatus ?? null,
              qr: fresh.stop.creditNoteQr ?? null,
            }
          : null),
    };
  }

  /** Reject on the ERP with the office's note, re-read the run, answer from the mirror. */
  async reject(
    stopId: string,
    dto: RejectReturnDto,
    actor: AuthenticatedUser,
    idempotencyKey?: string,
  ): Promise<{ stop: StopView }> {
    const { stop, run } = await this.stopAndRun(stopId);
    await this.erp.rejectReturn(
      stop.erpId,
      { rejectedBy: await this.decider(actor), note: dto.note.trim() },
      this.key(idempotencyKey),
    );
    await this.remirror(run.erpId);
    return { stop: (await this.freshStop(stop.id)).view };
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** ReturnRequest rows, in the order of `ids`. */
  private async requests(ids: string[]): Promise<ReturnRequestView[]> {
    const stops = await this.stops.find({ where: { id: In(ids) } });
    const runs = await this.runs.find({ where: { id: In([...new Set(stops.map((s) => s.runId))]) } });
    const lines = await this.lines.find({ where: { stopId: In(ids) } });
    const views = await this.deliveries.stopViews(stops, { audience: 'dashboard' });
    const repIds = [...new Set(runs.map((r) => r.repId).filter((x): x is string => !!x))];
    const reps = repIds.length ? await this.reps.find({ where: { id: In(repIds) }, withDeleted: true }) : [];
    const repById = new Map<string, RepRef>(
      reps.map((r) => [r.id, { id: r.id, code: r.code ?? null, nameAr: r.nameAr, nameEn: r.nameEn ?? null }]),
    );
    const runById = new Map(runs.map((r) => [r.id, r]));
    const byId = new Map(stops.map((s, i) => [s.id, { stop: s, view: views[i] }]));
    return ids
      .filter((id) => byId.has(id))
      .map((id) => {
        const { stop, view } = byId.get(id)!;
        const run = runById.get(stop.runId)!;
        return returnRequestView(
          stop,
          view,
          lines.filter((l) => l.stopId === id),
          {
            id: run.id,
            runNumber: run.runNumber ?? null,
            runDate: run.runDate ?? null,
            rep: run.repId ? (repById.get(run.repId) ?? null) : null,
          },
        );
      });
  }

  private async stopAndRun(stopId: string): Promise<{ stop: DeliveryStop; run: DeliveryRun }> {
    const stop = await this.stops.findOne({ where: { id: stopId } });
    const run = stop ? await this.runs.findOne({ where: { id: stop.runId } }) : null;
    if (!stop || !run) {
      throw new NotFoundException({ message: `Stop ${stopId} not found`, code: 'STOP_NOT_FOUND' });
    }
    return { stop, run };
  }

  private async freshStop(stopId: string): Promise<{ stop: DeliveryStop; view: StopView }> {
    const stop = await this.stops.findOneOrFail({ where: { id: stopId } });
    const [view] = await this.deliveries.stopViews([stop], { audience: 'dashboard' });
    return { stop, view };
  }

  /**
   * The decision is already made on the ERP; a failed re-read must not turn it
   * into an error. The next pull carries it (and tells the rep then).
   */
  private async remirror(runErpId: string): Promise<void> {
    await this.mirror.pullRun(runErpId).catch((e: unknown) =>
      this.logger.warn(
        `re-reading run ${runErpId} after a return decision failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  /** The office user, as the ERP records the decider: `{ id, name }`. */
  private async decider(actor: AuthenticatedUser): Promise<{ id: string; name: string }> {
    const rows: Array<{ name: string | null; user_number: string | null }> = await this.dataSource.query(
      `SELECT name, user_number FROM users WHERE id = $1`,
      [actor.sub],
    );
    return { id: actor.sub, name: rows[0]?.name || rows[0]?.user_number || actor.userNumber || actor.sub };
  }

  /** The dashboard's key per click; one is minted when a caller sends none. */
  private key(header?: string): string {
    const k = (header ?? '').trim();
    return k && k.length <= 255 ? k : randomUUID();
  }

  private async timezone(): Promise<string> {
    const rows: Array<{ timezone: string | null }> = await this.dataSource
      .query(`SELECT timezone FROM app_settings WHERE id = 1`)
      .catch(() => []);
    return rows[0]?.timezone || 'Asia/Amman';
  }
}
