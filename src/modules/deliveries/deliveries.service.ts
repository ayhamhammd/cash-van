import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';

import { Rep, canDeliver } from '../reps/entities/rep.entity';
import { SettingsService } from '../settings/settings.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { DeliveryErpClient, type PatchRunInput } from './delivery-erp.client';
import { DeliveryMirrorService } from './delivery-mirror.service';
import { DeliveryRun } from './entities/delivery-run.entity';
import { DeliveryStop } from './entities/delivery-stop.entity';
import { DeliveryStopLine } from './entities/delivery-stop-line.entity';
import type { ErpDeliveryRun, ErpLoadWarning } from './erp-delivery.types';
import {
  runSummaryView,
  stopView,
  type CustomerRef,
  type RepRef,
  type RunDetailView,
  type RunSummaryView,
  type StopView,
} from './delivery-views';
import type {
  CreateRunDto,
  DeliveryHistoryQuery,
  ListRunsQuery,
  LoadableInvoicesQuery,
  PatchRunDto,
} from './dto/deliveries.dto';

export interface LoadableInvoice {
  erpInvoiceId: string;
  invoiceNumber: string | null;
  issuedAt: string | null;
  status: string | null;
  paid: boolean;
  customer: CustomerRef | null;
  totalFils: number;
  paidFils: number;
  paymentType: string | null;
  salesmanName: string | null;
}

/** A collection counts towards a stop once it is confirmed (or banked since). */
const COUNTED_COLLECTION = ['confirmed', 'deposited'];

/** How far back `deliveries/mine` keeps a finished stop on the phone. */
const RECENT_DAYS = 2;

/**
 * Delivery runs for the dashboard and the delivery rep's phone
 * (docs/SPEC-delivery-rep.md §6.1–6.2, delivery phase-1 contract §B).
 *
 * Reads come from the mirror. Writes go to the ERP live — the office is online
 * and "this invoice is on another run" must come back at once — then the run is
 * re-read into the mirror and the answer is built from the mirror, so the
 * dashboard never shows a run the phones are not also about to see.
 */
@Injectable()
export class DeliveriesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(DeliveryRun) private readonly runs: Repository<DeliveryRun>,
    @InjectRepository(DeliveryStop) private readonly stops: Repository<DeliveryStop>,
    @InjectRepository(DeliveryStopLine) private readonly lines: Repository<DeliveryStopLine>,
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
    private readonly settings: SettingsService,
    private readonly erp: DeliveryErpClient,
    private readonly mirror: DeliveryMirrorService,
  ) {}

  // ── the delivery rep ────────────────────────────────────────────────────

  /** The caller's rep, when it is DELIVERY or BOTH; 403 otherwise. */
  async requireDeliveryRep(actor: AuthenticatedUser): Promise<Rep> {
    const rep = actor?.repId
      ? await this.reps.findOne({ where: { id: actor.repId } })
      : null;
    if (!rep || !canDeliver(rep.kind)) {
      throw new ForbiddenException({
        message: 'Only a delivery rep (kind DELIVERY or BOTH) can use the delivery screens',
        code: 'NOT_A_DELIVERY_REP',
      });
    }
    return rep;
  }

  // ── dashboard reads ─────────────────────────────────────────────────────

  async listRuns(q: ListRunsQuery): Promise<{ items: RunSummaryView[] }> {
    const qb = this.runs.createQueryBuilder('r').orderBy('r.run_date', 'DESC', 'NULLS LAST')
      .addOrderBy('r.run_number', 'DESC')
      .take(500);
    if (q.date) qb.andWhere('r.run_date = :date', { date: q.date });
    if (q.repId) qb.andWhere('r.rep_id = :repId', { repId: q.repId });
    if (q.status) qb.andWhere('r.status = :status', { status: q.status });
    const runs = await qb.getMany();
    const details = await this.details(runs, { lines: false });
    return { items: details.map(({ stops: _stops, ...summary }) => summary) };
  }

  async runDetail(id: string): Promise<RunDetailView> {
    const run = await this.runs.findOne({ where: { id } });
    if (!run) throw new NotFoundException(`Delivery run ${id} not found`);
    return (await this.details([run]))[0];
  }

  /** The stop that carries this invoice — the open run's first, else the latest. */
  async stopByInvoice(
    invoiceNumber: string,
  ): Promise<StopView & { run: Pick<RunSummaryView, 'id' | 'runNumber' | 'runDate' | 'status' | 'rep'> }> {
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `SELECT s.id
         FROM delivery_stops s
         JOIN delivery_runs r ON r.id = s.run_id
        WHERE s.invoice_number = $1
        ORDER BY (r.status = 'OPEN') DESC, r.run_date DESC NULLS LAST, s.updated_at DESC
        LIMIT 1`,
      [invoiceNumber],
    );
    if (!rows[0]) throw new NotFoundException(`Invoice ${invoiceNumber} is on no delivery run`);
    const stop = await this.stops.findOneOrFail({ where: { id: rows[0].id } });
    const run = await this.runs.findOneOrFail({ where: { id: stop.runId } });
    const [detail] = await this.details([run], { onlyStopIds: [stop.id] });
    return {
      ...detail.stops[0],
      run: {
        id: detail.id,
        runNumber: detail.runNumber,
        runDate: detail.runDate,
        status: detail.status,
        rep: detail.rep,
      },
    };
  }

  async vehicles(): Promise<{ items: Array<{ erpId: string; name: string | null; plateNumber: string | null }> }> {
    const list = await this.erp.vehicles();
    return {
      items: list.map((v) => ({ erpId: v.id, name: v.name ?? null, plateNumber: v.plateNumber ?? null })),
    };
  }

  /**
   * ERP invoices that can go on a run, from the local `erp_invoices` mirror:
   * issued or partially paid (paid too when unpaidOnly=false, flagged), not on
   * a LOADED stop of an OPEN run.
   */
  async loadableInvoices(q: LoadableInvoicesQuery): Promise<{ items: LoadableInvoice[]; total: number }> {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const unpaidOnly = q.unpaidOnly !== false;
    const tz = await this.timezone();
    const params: unknown[] = [];
    const p = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    const where: string[] = [
      'ei.deleted_at IS NULL',
      `ei.status IN (${(unpaidOnly ? ['issued', 'partially_paid'] : ['issued', 'partially_paid', 'paid'])
        .map((s) => p(s))
        .join(', ')})`,
      `NOT EXISTS (
         SELECT 1 FROM delivery_stops s
           JOIN delivery_runs r ON r.id = s.run_id
          WHERE r.status = 'OPEN' AND s.status = 'LOADED'
            AND (s.erp_invoice_id = ei.erp_id OR s.invoice_number = ei.invoice_number))`,
    ];
    if (q.from) where.push(`(ei.issued_at AT TIME ZONE ${p(tz)})::date >= ${p(q.from)}::date`);
    if (q.to) where.push(`(ei.issued_at AT TIME ZONE ${p(tz)})::date <= ${p(q.to)}::date`);
    if (q.customerId) where.push(`ei.customer_id = ${p(q.customerId)}`);
    if (q.areaId) where.push(`c.area_id = ${p(q.areaId)}`);
    if (q.locationId) {
      // The whole subtree, as the customers list filters it.
      where.push(
        `c.location_id IN (
           SELECT l.id FROM locations l
            WHERE l.deleted_at IS NULL
              AND l.path LIKE (SELECT lp.path FROM locations lp WHERE lp.id = ${p(q.locationId)}) || '%')`,
      );
    }
    if (q.salesmanCode) {
      const code = p(q.salesmanCode);
      // erp_invoices carries the credited rep and the salesman's name, not his
      // code: match either through the rep that has the code.
      where.push(
        `EXISTS (SELECT 1 FROM reps sr
                  WHERE sr.code = ${code} AND sr.deleted_at IS NULL
                    AND (ei.rep_id = sr.id OR ei.salesman_name IN (sr.name_ar, sr.name_en)))`,
      );
    }
    for (const token of (q.q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5)) {
      const t = p(`%${token}%`);
      where.push(
        `(ei.invoice_number ILIKE ${t} OR c.name_ar ILIKE ${t} OR c.customer_name ILIKE ${t}
          OR c.customer_number ILIKE ${t})`,
      );
    }
    const rows: Array<{
      erp_id: string;
      invoice_number: string | null;
      issued_at: Date | null;
      status: string | null;
      total_fils: string;
      paid_fils: string;
      payment_type: string | null;
      salesman_name: string | null;
      customer_id: string | null;
      total: string;
    }> = await this.dataSource.query(
      `SELECT ei.erp_id, ei.invoice_number, ei.issued_at, ei.status, ei.total_fils, ei.paid_fils,
              ei.payment_type, ei.salesman_name, ei.customer_id, count(*) OVER () AS total
         FROM erp_invoices ei
         LEFT JOIN customers c ON c.id = ei.customer_id
        WHERE ${where.join('\n          AND ')}
        ORDER BY ei.issued_at DESC, ei.invoice_number DESC
        LIMIT ${p(pageSize)} OFFSET ${p((page - 1) * pageSize)}`,
      params,
    );
    const customers = await this.customerRefs(rows.map((r) => r.customer_id));
    return {
      total: rows.length ? Number(rows[0].total) : 0,
      items: rows.map((r) => ({
        erpInvoiceId: r.erp_id,
        invoiceNumber: r.invoice_number,
        issuedAt: r.issued_at ? new Date(r.issued_at).toISOString() : null,
        status: r.status,
        paid: r.status === 'paid',
        customer: r.customer_id ? (customers.get(r.customer_id) ?? null) : null,
        totalFils: Number(r.total_fils),
        paidFils: Number(r.paid_fils),
        paymentType: r.payment_type,
        salesmanName: r.salesman_name,
      })),
    };
  }

  // ── dashboard writes (live to the ERP) ──────────────────────────────────

  async createRun(dto: CreateRunDto): Promise<RunDetailView & { warnings: ErpLoadWarning[] }> {
    const rep = await this.deliveryRepOrThrow(dto.repId);
    const { run, warnings } = await this.erp.createRun({
      externalId: randomUUID(),
      driverSalesmanCode: rep.code!,
      ...(dto.vehicleErpId ? { vehicleId: dto.vehicleErpId } : {}),
      ...(dto.runDate ? { runDate: dto.runDate } : {}),
      invoiceNumbers: dto.invoiceNumbers.map((n) => n.trim()),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    });
    const id = await this.remirror(run, null);
    return { ...(await this.runDetail(id)), warnings };
  }

  async patchRun(id: string, dto: PatchRunDto): Promise<RunDetailView & { warnings: ErpLoadWarning[] }> {
    const run = await this.runs.findOne({ where: { id } });
    if (!run) throw new NotFoundException(`Delivery run ${id} not found`);
    const body: PatchRunInput = {};
    if (dto.addInvoiceNumbers?.length) body.addInvoiceNumbers = dto.addInvoiceNumbers.map((n) => n.trim());
    if (dto.removeStopIds?.length) body.removeItemIds = await this.itemIds(run.id, dto.removeStopIds);
    if (dto.order?.length) body.order = await this.itemIds(run.id, dto.order);
    if (dto.repId) body.driverSalesmanCode = (await this.deliveryRepOrThrow(dto.repId)).code!;
    if (dto.vehicleErpId !== undefined) body.vehicleId = dto.vehicleErpId;
    if (dto.notes !== undefined) body.notes = dto.notes;
    const { run: answer, warnings } = await this.erp.patchRun(run.erpId, body);
    await this.remirror(answer, run.erpId);
    // The ERP's ALREADY_PAID warnings for added invoices, passed through.
    return { ...(await this.runDetail(id)), warnings };
  }

  async closeRun(id: string): Promise<RunDetailView> {
    const run = await this.runs.findOne({ where: { id } });
    if (!run) throw new NotFoundException(`Delivery run ${id} not found`);
    const answer = await this.erp.closeRun(run.erpId);
    await this.remirror(answer, run.erpId);
    return this.runDetail(id);
  }

  // ── the phone ───────────────────────────────────────────────────────────

  /** OPEN runs of this rep, plus stops he finished in the last 2 days. */
  async mine(actor: AuthenticatedUser): Promise<{ runs: RunDetailView[]; serverTime: string }> {
    const rep = await this.requireDeliveryRep(actor);
    const open = await this.runs.find({ where: { repId: rep.id, status: 'OPEN' } });
    const recent: Array<{ id: string; run_id: string }> = await this.dataSource.query(
      `SELECT s.id, s.run_id
         FROM delivery_stops s
         JOIN delivery_runs r ON r.id = s.run_id
        WHERE r.rep_id = $1 AND r.status = 'CLOSED'
          AND COALESCE(s.delivered_at, s.local_delivered_at) >= now() - ($2 || ' days')::interval`,
      [rep.id, String(RECENT_DAYS)],
    );
    const closedIds = [...new Set(recent.map((r) => r.run_id))];
    const closed = closedIds.length ? await this.runs.find({ where: { id: In(closedIds) } }) : [];
    const openDetails = await this.details(open);
    const closedDetails = closed.length
      ? await this.details(closed, { onlyStopIds: recent.map((r) => r.id) })
      : [];
    const runs = [...openDetails, ...closedDetails].sort((a, b) =>
      String(b.runDate ?? '').localeCompare(String(a.runDate ?? '')),
    );
    return { runs, serverTime: new Date().toISOString() };
  }

  async history(
    actor: AuthenticatedUser,
    q: DeliveryHistoryQuery,
  ): Promise<{ items: Array<StopView & { run: { id: string; runNumber: string | null; runDate: string | null } }>; total: number }> {
    const rep = await this.requireDeliveryRep(actor);
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const tz = await this.timezone();
    const params: unknown[] = [rep.id];
    const p = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = ['r.rep_id = $1'];
    if (q.status) where.push(`s.status = ${p(q.status)}`);
    else where.push(`(s.status <> 'LOADED' OR s.local_result_ref IS NOT NULL)`);
    const at = 'COALESCE(s.delivered_at, s.local_delivered_at)';
    if (q.from) where.push(`(${at} AT TIME ZONE ${p(tz)})::date >= ${p(q.from)}::date`);
    if (q.to) where.push(`(${at} AT TIME ZONE ${p(tz)})::date <= ${p(q.to)}::date`);
    if (q.customerId) where.push(`s.customer_id = ${p(q.customerId)}`);
    const rows: Array<{ id: string; total: string }> = await this.dataSource.query(
      `SELECT s.id, count(*) OVER () AS total
         FROM delivery_stops s
         JOIN delivery_runs r ON r.id = s.run_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${at} DESC NULLS LAST, s.updated_at DESC
        LIMIT ${p(pageSize)} OFFSET ${p((page - 1) * pageSize)}`,
      params,
    );
    if (!rows.length) return { items: [], total: 0 };
    const stops = await this.stops.find({ where: { id: In(rows.map((r) => r.id)) } });
    const runs = await this.runs.find({ where: { id: In([...new Set(stops.map((s) => s.runId))]) } });
    const views = await this.stopViews(stops);
    const runById = new Map(runs.map((r) => [r.id, r]));
    const byId = new Map(stops.map((s, i) => [s.id, { stop: s, view: views[i] }]));
    return {
      total: Number(rows[0].total),
      items: rows.map((r) => {
        const { stop, view } = byId.get(r.id)!;
        const run = runById.get(stop.runId)!;
        return { ...view, run: { id: run.id, runNumber: run.runNumber ?? null, runDate: run.runDate ?? null } };
      }),
    };
  }

  /** One stop of this rep's runs, fresh from the mirror. */
  async appStop(actor: AuthenticatedUser, id: string): Promise<StopView> {
    const rep = await this.requireDeliveryRep(actor);
    const stop = await this.stops.findOne({ where: { id } });
    const run = stop ? await this.runs.findOne({ where: { id: stop.runId } }) : null;
    if (!stop || !run || run.repId !== rep.id) throw new NotFoundException(`Stop ${id} not found`);
    return (await this.stopViews([stop]))[0];
  }

  // ── building the answers ────────────────────────────────────────────────

  /** RunDetail for each run, in the order given. */
  async details(
    runs: DeliveryRun[],
    opts: { lines?: boolean; onlyStopIds?: string[] } = {},
  ): Promise<RunDetailView[]> {
    if (!runs.length) return [];
    const runIds = runs.map((r) => r.id);
    let stops = await this.stops.find({
      where: { runId: In(runIds) },
      order: { sequence: 'ASC', createdAt: 'ASC' },
    });
    if (opts.onlyStopIds) {
      const only = new Set(opts.onlyStopIds);
      stops = stops.filter((s) => only.has(s.id));
    }
    const views = await this.stopViews(stops, { lines: opts.lines !== false });
    const repIds = [...new Set(runs.map((r) => r.repId).filter((x): x is string => !!x))];
    const reps = repIds.length ? await this.reps.find({ where: { id: In(repIds) }, withDeleted: true }) : [];
    const repById = new Map<string, RepRef>(
      reps.map((r) => [r.id, { id: r.id, code: r.code ?? null, nameAr: r.nameAr, nameEn: r.nameEn ?? null }]),
    );
    return runs.map((run) => {
      const own = views.filter((_, i) => stops[i].runId === run.id);
      const rep = run.repId ? (repById.get(run.repId) ?? null) : null;
      return { ...runSummaryView(run, own, rep), stops: own };
    });
  }

  private async stopViews(stops: DeliveryStop[], opts: { lines?: boolean } = {}): Promise<StopView[]> {
    if (!stops.length) return [];
    const ids = stops.map((s) => s.id);
    const lines = opts.lines === false ? [] : await this.lines.find({ where: { stopId: In(ids) } });
    const linesBy = new Map<string, DeliveryStopLine[]>();
    for (const l of lines) linesBy.set(l.stopId, [...(linesBy.get(l.stopId) ?? []), l]);
    const customers = await this.customerRefs(stops.map((s) => s.customerId ?? null));
    const collected = await this.collectedByInvoice(stops.map((s) => s.invoiceNumber ?? null));
    return stops.map((s) =>
      stopView(
        s,
        linesBy.get(s.id) ?? [],
        s.customerId ? (customers.get(s.customerId) ?? null) : null,
        s.invoiceNumber ? (collected.get(s.invoiceNumber) ?? 0) : 0,
      ),
    );
  }

  /**
   * { id, customerNumber, name, placeLabel } per customer. placeLabel is the
   * tree label ("governorate - area") in TREE mode, else the flat area's name,
   * else the city.
   */
  async customerRefs(ids: Array<string | null>): Promise<Map<string, CustomerRef>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map();
    const tree = (await this.settings.locationMode()) === 'TREE';
    const rows: Array<{ id: string; customer_number: string; name: string; place_label: string | null }> =
      await this.dataSource.query(
        `SELECT c.id, c.customer_number,
                COALESCE(NULLIF(c.name_ar, ''), c.customer_name) AS name,
                CASE WHEN $2::boolean AND l.id IS NOT NULL
                     THEN CASE WHEN g.id IS NOT NULL THEN g.name_ar || ' - ' || l.name_ar ELSE l.name_ar END
                     ELSE COALESCE(ca.name_ar, NULLIF(c.city, '')) END AS place_label
           FROM customers c
           LEFT JOIN locations l ON l.id = c.location_id AND l.deleted_at IS NULL
           LEFT JOIN locations g ON g.id = l.parent_id AND g.kind = 'GOVERNORATE'
           LEFT JOIN customer_areas ca ON ca.id = c.area_id AND ca.deleted_at IS NULL
          WHERE c.id = ANY($1::uuid[])`,
        [unique, tree],
      );
    return new Map(
      rows.map((r) => [
        r.id,
        { id: r.id, customerNumber: r.customer_number, name: r.name, placeLabel: r.place_label ?? null },
      ]),
    );
  }

  /** Σ confirmed collections taken against each ERP invoice number, in fils. */
  private async collectedByInvoice(numbers: Array<string | null>): Promise<Map<string, number>> {
    const unique = [...new Set(numbers.filter((x): x is string => !!x))];
    if (!unique.length) return new Map();
    const rows: Array<{ n: string; fils: string }> = await this.dataSource.query(
      `SELECT erp_invoice_number AS n, COALESCE(SUM(amount), 0) AS fils
         FROM collections
        WHERE erp_invoice_number = ANY($1::text[]) AND status = ANY($2::text[])
        GROUP BY erp_invoice_number`,
      [unique, COUNTED_COLLECTION],
    );
    return new Map(rows.map((r) => [r.n, Number(r.fils)]));
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** The rep a run is assigned to: must exist, have a code, and be able to deliver. */
  private async deliveryRepOrThrow(repId: string): Promise<Rep> {
    const rep = await this.reps.findOne({ where: { id: repId } });
    if (!rep?.code) {
      throw new UnprocessableEntityException({
        message: rep ? 'This rep has no code, so the ERP cannot know him as a salesman' : `Rep ${repId} not found`,
        code: 'SALESMAN_NOT_FOUND',
      });
    }
    if (!canDeliver(rep.kind)) {
      throw new UnprocessableEntityException({
        message: 'Only a delivery rep (kind DELIVERY or BOTH) can drive a run',
        code: 'REP_NOT_DELIVERY',
      });
    }
    return rep;
  }

  /** Mirror stop ids → the ERP item ids, all of which must be on this run. */
  private async itemIds(runId: string, stopIds: string[]): Promise<string[]> {
    const rows = await this.stops.find({ where: { id: In(stopIds), runId } });
    const byId = new Map(rows.map((s) => [s.id, s.erpId]));
    const missing = stopIds.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new BadRequestException({
        message: `Not stops of this run: ${missing.join(', ')}`,
        code: 'STOP_NOT_ON_RUN',
      });
    }
    return stopIds.map((id) => byId.get(id)!);
  }

  /**
   * After a write the ERP accepted: mirror the run it answered with, or re-read
   * it when the answer carried none. Returns the mirror run id.
   */
  private async remirror(answer: ErpDeliveryRun | null, erpId: string | null): Promise<string> {
    if (answer?.id && Array.isArray(answer.items)) {
      return (await this.mirror.applyRun(answer)).runId;
    }
    const id = answer?.id ?? erpId;
    if (!id) throw new NotFoundException('The ERP answered without a run');
    const res = await this.mirror.pullRun(String(id));
    if (!res) throw new NotFoundException(`The ERP no longer has run ${id}`);
    return res.runId;
  }

  private async timezone(): Promise<string> {
    const rows: Array<{ timezone: string | null }> = await this.dataSource
      .query(`SELECT timezone FROM app_settings WHERE id = 1`)
      .catch(() => []);
    return rows[0]?.timezone || 'Asia/Amman';
  }
}
