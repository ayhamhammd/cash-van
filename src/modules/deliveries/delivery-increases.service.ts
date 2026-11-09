import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { toFils } from '../erp-sync/erp-sync.service';
import { canDeliver, Rep } from '../reps/entities/rep.entity';
import { VouchersService } from '../vouchers/vouchers.service';
import { PricingService } from '../products/pricing.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { CreateVoucherDto } from '../vouchers/dto/create-voucher.dto';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { DeliveriesService } from './deliveries.service';
import { DeliveryMirrorService } from './delivery-mirror.service';
import {
  DeliveryIncreaseRequest,
  type IncreaseLine,
  type IncreaseStatus,
} from './entities/delivery-increase-request.entity';
import type { CustomerRef } from './delivery-views';
import { PRODUCT_UNIT_SQL, increaseLineOf, withBaseUnits, type ProductUnitRow } from './delivery-increase-units';
import type { DismissIncreaseDto, ListIncreasesQuery, OrderIncreaseDto } from './dto/deliveries.dto';

/** Contract §B `IncreaseRequest`. */
export interface IncreaseRequestView {
  id: string;
  status: IncreaseStatus;
  createdAt: string;
  run: { id: string; runNumber: string | null; runDate: string | null } | null;
  stop: { id: string; invoiceNumber: string | null } | null;
  customer: CustomerRef | null;
  rep: { id: string; code: string | null; nameAr: string } | null;
  lines: IncreaseLine[];
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  order: { id: string | null; voucherNumber: string; totalFils: number } | null;
}

/** Can this rep be the salesman of an order? SALES or BOTH, with a code to raise it under. */
export function sellsOrders(rep: Pick<Rep, 'kind' | 'code' | 'isActive'> | null | undefined): boolean {
  return !!rep?.code && rep.isActive !== false && (rep.kind === 'SALES' || rep.kind === 'BOTH');
}

/**
 * Who the order is raised for: the customer's own salesman when he sells
 * (SALES or BOTH), otherwise the delivery rep who brought the request back.
 */
export function orderSalesman<R extends Pick<Rep, 'kind' | 'code' | 'isActive'>>(
  customerRep: R | null | undefined,
  deliveryRep: R | null | undefined,
): R | null {
  if (sellsOrders(customerRep)) return customerRep!;
  if (deliveryRep?.code && canDeliver(deliveryRep.kind)) return deliveryRep;
  return null;
}

/** The voucher note that says where the order came from (ar / en). */
export function orderNote(invoiceNumber: string | null, note?: string | null): string {
  const inv = invoiceNumber ?? '';
  const base = `من طلب زيادة أثناء التوصيل — الفاتورة ${inv} / From a delivery increase request — invoice ${inv}`;
  return note?.trim() ? `${base}\n${note.trim()}` : base;
}

/**
 * Increase requests (phase-4 contract §B, docs/SPEC-delivery-rep.md §3.2).
 *
 * The rep never adds to the issued invoice (R2) and never sells from the truck
 * (Q1); the office decides. "Create order" goes through VouchersService.create
 * — the same path the dashboard's New voucher and the phone's sync/vouchers
 * use — so the order gets that path's tax (from the item), the customer's tax
 * exemption, the company's tax mode, its offers, its stock reservation and its
 * ERP SALES_ORDER outbox row. The one thing that path takes from its caller is
 * the line price, which comes from PricingService.quote: the customer's
 * contract price, then his price list, then the price rules, then the list
 * price — the same sources the path's own price-override floor checks.
 *
 * Each decision is idempotent on the dashboard's Idempotency-Key and runs
 * under a lock on the request, so a double click makes one order.
 */
@Injectable()
export class DeliveryIncreasesService {
  private readonly logger = new Logger(DeliveryIncreasesService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(DeliveryIncreaseRequest)
    private readonly requests: Repository<DeliveryIncreaseRequest>,
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
    private readonly vouchers: VouchersService,
    private readonly pricing: PricingService,
    private readonly deliveries: DeliveriesService,
    private readonly mirror: DeliveryMirrorService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(q: ListIncreasesQuery): Promise<{ items: IncreaseRequestView[]; total: number }> {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const status = q.status ?? 'PENDING';
    const params: unknown[] = [];
    const p = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (status === 'PENDING') where.push(`r.status = 'PENDING'`);
    else if (status === 'DECIDED') where.push(`r.status IN ('ORDERED', 'DISMISSED')`);
    if (q.repId) where.push(`r.rep_id = ${p(q.repId)}`);
    if (q.customerId) where.push(`r.customer_id = ${p(q.customerId)}`);
    if (q.from || q.to) {
      const tz = p(await this.timezone());
      if (q.from) where.push(`(r.created_at AT TIME ZONE ${tz})::date >= ${p(q.from)}::date`);
      if (q.to) where.push(`(r.created_at AT TIME ZONE ${tz})::date <= ${p(q.to)}::date`);
    }
    const rows: Array<{ id: string; total: string }> = await this.dataSource.query(
      `SELECT r.id, count(*) OVER () AS total
         FROM delivery_increase_requests r
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY (r.status = 'PENDING') DESC,
                 CASE WHEN r.status = 'PENDING' THEN r.created_at END ASC,
                 r.decided_at DESC NULLS LAST,
                 r.id
        LIMIT ${p(pageSize)} OFFSET ${p((page - 1) * pageSize)}`,
      params,
    );
    if (!rows.length) return { items: [], total: 0 };
    const found = await this.requests.find({ where: { id: In(rows.map((r) => r.id)) } });
    const byId = new Map(found.map((r) => [r.id, r]));
    const items = await this.views(rows.map((r) => byId.get(r.id)!).filter(Boolean));
    return { items, total: Number(rows[0].total) };
  }

  async count(): Promise<{ pending: number }> {
    const rows: Array<{ n: number }> = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM delivery_increase_requests WHERE status = 'PENDING'`,
    );
    return { pending: rows[0]?.n ?? 0 };
  }

  /**
   * Turn the request into an ORDER voucher for its customer. The same
   * Idempotency-Key again answers the same order; any other decision on a
   * decided request is 409 INCREASE_ALREADY_DECIDED.
   */
  async order(
    id: string,
    dto: OrderIncreaseDto,
    actor: AuthenticatedUser,
    idempotencyKey?: string,
  ): Promise<{ request: IncreaseRequestView; order: { id: string | null; voucherNumber: string; totalFils: number } }> {
    const key = this.key(idempotencyKey);
    const out = await this.locked(id, async () => {
      const req = await this.requestOrThrow(id);
      if (req.status !== 'PENDING') {
        if (req.status === 'ORDERED' && key && req.decisionKey === key && req.orderVoucherNumber) {
          return { req, replay: true };
        }
        throw this.alreadyDecided(req);
      }

      // As requested, with a pre-fix row's placeholder unit put right on the way.
      const lines = dto.lines?.length
        ? await this.orderLines(dto.lines)
        : await withBaseUnits((sql, p) => this.dataSource.query(sql, p), req.lines);
      const customer = req.customerId
        ? ((await this.dataSource.query(
            `SELECT id, customer_number, rep_id FROM customers WHERE id = $1 AND deleted_at IS NULL`,
            [req.customerId],
          )) as Array<{ id: string; customer_number: string; rep_id: string | null }>)[0]
        : undefined;
      if (!customer) {
        throw new UnprocessableEntityException({
          message: 'The stop has no customer in CashVan, so no order can be raised for it',
          code: 'CUSTOMER_NOT_FOUND',
        });
      }
      const [customerRep, deliveryRep] = await Promise.all([
        customer.rep_id ? this.reps.findOne({ where: { id: customer.rep_id } }) : null,
        req.repId ? this.reps.findOne({ where: { id: req.repId } }) : null,
      ]);
      // A voucher's user_code must be a login (voucher_headers.user_code →
      // users.user_number). Provisioning always makes one, but a rep without it
      // would fail as a bare foreign-key error, so he is passed over here.
      const logins = await this.loginsFor([customerRep?.code, deliveryRep?.code]);
      const withLogin = <R extends { code?: string | null }>(r: R | null) =>
        r?.code && logins.has(r.code) ? r : null;
      const salesman = orderSalesman(withLogin(customerRep), withLogin(deliveryRep));
      if (!salesman) {
        throw new UnprocessableEntityException({
          message: 'Neither the customer’s salesman nor the delivery rep can take an order (no code or no login)',
          code: 'SALESMAN_NOT_FOUND',
        });
      }

      const transactions = [];
      for (const l of lines) {
        const quote = await this.pricing.quote(l.productId, l.qty, customer.id);
        transactions.push({
          itemNumber: l.skuCode,
          itemName: l.nameEn || l.nameAr || l.skuCode,
          itemQty: String(l.qty),
          unitPrice: (quote.finalUnitPrice / 1000).toFixed(3),
          storeNumber: salesman.code!,
        });
      }
      const voucher: CreateVoucherDto = {
        transKind: 'ORDER',
        userCode: salesman.code!,
        customerNumber: customer.customer_number,
        notes: orderNote(req.invoiceNumber ?? null, dto.note),
        isPosted: true,
        transactions,
      } as CreateVoucherDto;

      let created;
      try {
        created = await this.vouchers.create(voucher);
      } catch (e) {
        throw this.asOrderRefusal(e);
      }

      req.status = 'ORDERED';
      req.lines = lines;
      req.orderVoucherId = created.id;
      req.orderVoucherNumber = created.voucherNumber;
      req.orderTotalFils = String(toFils(created.netTotal));
      req.decidedBy = await this.deciderName(actor);
      req.decidedAt = new Date();
      req.decisionNote = dto.note?.trim() || null;
      req.decisionKey = key;
      await this.requests.save(req);
      return { req, replay: false };
    });

    if (!out.replay) {
      await this.notifyRep(out.req, {
        kind: 'delivery.increase_ordered',
        titleAr: 'طلب الزيادة أُنشئ كأمر بيع',
        titleEn: 'Increase request ordered',
        bodyAr: `طلب الزيادة للفاتورة ${out.req.invoiceNumber ?? ''} أُنشئ كأمر بيع ${out.req.orderVoucherNumber}`,
        bodyEn: `The increase request for invoice ${out.req.invoiceNumber ?? ''} became sales order ${out.req.orderVoucherNumber}`,
      });
      this.signal(out.req);
    }
    const [view] = await this.views([out.req]);
    return {
      request: view,
      order: {
        id: out.req.orderVoucherId ?? null,
        voucherNumber: out.req.orderVoucherNumber!,
        totalFils: Number(out.req.orderTotalFils ?? 0),
      },
    };
  }

  /** Dismiss with the office's note. Same key again answers the same; otherwise 409 once decided. */
  async dismiss(
    id: string,
    dto: DismissIncreaseDto,
    actor: AuthenticatedUser,
    idempotencyKey?: string,
  ): Promise<{ request: IncreaseRequestView }> {
    const key = this.key(idempotencyKey);
    const out = await this.locked(id, async () => {
      const req = await this.requestOrThrow(id);
      if (req.status !== 'PENDING') {
        if (req.status === 'DISMISSED' && key && req.decisionKey === key) return { req, replay: true };
        throw this.alreadyDecided(req);
      }
      req.status = 'DISMISSED';
      req.decidedBy = await this.deciderName(actor);
      req.decidedAt = new Date();
      req.decisionNote = dto.note.trim();
      req.decisionKey = key;
      await this.requests.save(req);
      return { req, replay: false };
    });
    if (!out.replay) {
      await this.notifyRep(out.req, {
        kind: 'delivery.increase_dismissed',
        titleAr: 'رُفض طلب الزيادة',
        titleEn: 'Increase request dismissed',
        bodyAr: `رُفض طلب الزيادة: ${out.req.decisionNote}`,
        bodyEn: `Increase request dismissed: ${out.req.decisionNote}`,
      });
      this.signal(out.req);
    }
    const [view] = await this.views([out.req]);
    return { request: view };
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * Run `fn` holding a session-level advisory lock on the request. Session, not
   * transaction: the order is written by VouchersService in a transaction of
   * its own, and the lock has to cover that and the request's update after it.
   */
  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query(`SELECT pg_advisory_lock(hashtext($1))`, [`delivery_increase:${id}`]);
      try {
        return await fn();
      } finally {
        await qr.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`delivery_increase:${id}`]);
      }
    } finally {
      await qr.release();
    }
  }

  /** Which of these codes are logins (users.user_number). */
  private async loginsFor(codes: Array<string | null | undefined>): Promise<Set<string>> {
    const list = [...new Set(codes.filter((c): c is string => !!c))];
    if (!list.length) return new Set();
    const rows: Array<{ user_number: string }> = await this.dataSource.query(
      `SELECT user_number FROM users WHERE user_number = ANY($1::text[])`,
      [list],
    );
    return new Set(rows.map((r) => r.user_number));
  }

  private async requestOrThrow(id: string): Promise<DeliveryIncreaseRequest> {
    const req = await this.requests.findOne({ where: { id } });
    if (!req) {
      throw new NotFoundException({ message: `Increase request ${id} not found`, code: 'INCREASE_NOT_FOUND' });
    }
    return req;
  }

  private alreadyDecided(req: DeliveryIncreaseRequest): ConflictException {
    return new ConflictException({
      message: `This increase request is already ${req.status.toLowerCase()}`,
      code: 'INCREASE_ALREADY_DECIDED',
    });
  }

  /** The office's edited lines, each a known active product, names snapshotted again. */
  private async orderLines(lines: Array<{ productId: string; qty: number }>): Promise<IncreaseLine[]> {
    const ids = [...new Set(lines.map((l) => l.productId))];
    const rows: ProductUnitRow[] = await this.dataSource.query(
      `${PRODUCT_UNIT_SQL} AND ic.is_active AND ic.deleted_at IS NULL`,
      [ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new UnprocessableEntityException({
        message: `Unknown or inactive product(s): ${missing.join(', ')}`,
        code: 'PRODUCT_NOT_FOUND',
      });
    }
    const by = new Map<string, number>();
    for (const l of lines) by.set(l.productId, (by.get(l.productId) ?? 0) + l.qty);
    return [...by.entries()].map(([productId, qty]) => increaseLineOf(byId.get(productId)!, qty));
  }

  /**
   * The vouchers service's own refusal, as 422 with its code. Its messages are
   * written for people ("اختر العميل…"), so they are kept; a bare string is
   * given the generic code ORDER_REJECTED.
   */
  private asOrderRefusal(e: unknown): unknown {
    if (!(e instanceof HttpException)) return e;
    const status = e.getStatus();
    if (status !== 400 && status !== 403 && status !== 409 && status !== 422) return e;
    const res = e.getResponse();
    const obj = typeof res === 'object' && res ? (res as Record<string, unknown>) : {};
    const message =
      typeof res === 'string' ? res : (obj.message as string | string[] | undefined) ?? e.message;
    const fromMessage = typeof message === 'string' && /^[A-Z][A-Z_:]+$/.test(message) ? message : undefined;
    return new UnprocessableEntityException({
      message,
      code: (typeof obj.code === 'string' ? obj.code : undefined) ?? fromMessage ?? 'ORDER_REJECTED',
    });
  }

  private async notifyRep(
    req: DeliveryIncreaseRequest,
    n: { kind: string; titleAr: string; titleEn: string; bodyAr: string; bodyEn: string },
  ): Promise<void> {
    if (!req.repId) return;
    try {
      const rows: Array<{ user_id: string | null }> = await this.dataSource.query(
        `SELECT user_id FROM reps WHERE id = $1`,
        [req.repId],
      );
      const userId = rows[0]?.user_id;
      if (!userId) return;
      await this.notifications.notifyUser(userId, {
        ...n,
        refType: 'delivery_stop',
        refId: req.stopId ?? req.id,
      });
    } catch (e) {
      this.logger.warn(`increase decision notification failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The stop changed (it carries the request): dashboards re-read, the rep's phone re-pulls. */
  private signal(req: DeliveryIncreaseRequest): void {
    if (!req.runId) return;
    this.mirror.signal(
      {
        runId: req.runId,
        repId: req.repId ?? null,
        previousRepId: req.repId ?? null,
        runChanged: false,
        changedStopIds: req.stopId ? [req.stopId] : [],
        removedStopIds: [],
      },
      'delivery.increase.decided',
    );
  }

  private async views(reqs: DeliveryIncreaseRequest[]): Promise<IncreaseRequestView[]> {
    if (!reqs.length) return [];
    const runIds = [...new Set(reqs.map((r) => r.runId).filter((x): x is string => !!x))];
    const stopIds = [...new Set(reqs.map((r) => r.stopId).filter((x): x is string => !!x))];
    const repIds = [...new Set(reqs.map((r) => r.repId).filter((x): x is string => !!x))];
    const [runs, stops, reps, customers] = await Promise.all([
      runIds.length
        ? (this.dataSource.query(`SELECT id, run_number, run_date FROM delivery_runs WHERE id = ANY($1::uuid[])`, [runIds]) as Promise<
            Array<{ id: string; run_number: string | null; run_date: string | null }>
          >)
        : Promise.resolve([]),
      stopIds.length
        ? (this.dataSource.query(`SELECT id, invoice_number FROM delivery_stops WHERE id = ANY($1::uuid[])`, [stopIds]) as Promise<
            Array<{ id: string; invoice_number: string | null }>
          >)
        : Promise.resolve([]),
      repIds.length ? this.reps.find({ where: { id: In(repIds) }, withDeleted: true }) : Promise.resolve([]),
      this.deliveries.customerRefs(reqs.map((r) => r.customerId ?? null)),
    ]);
    const runBy = new Map(runs.map((r) => [r.id, r]));
    const stopBy = new Map(stops.map((s) => [s.id, s]));
    const repBy = new Map(reps.map((r) => [r.id, r]));
    const linesOf = await Promise.all(
      reqs.map((r) => withBaseUnits((sql, p) => this.dataSource.query(sql, p), r.lines ?? [])),
    );
    return reqs.map((r, i) => {
      const run = r.runId ? runBy.get(r.runId) : undefined;
      const stop = r.stopId ? stopBy.get(r.stopId) : undefined;
      const rep = r.repId ? repBy.get(r.repId) : undefined;
      return {
        id: r.id,
        status: r.status,
        createdAt: new Date(r.createdAt).toISOString(),
        run: run ? { id: run.id, runNumber: run.run_number, runDate: run.run_date } : null,
        stop: r.stopId ? { id: r.stopId, invoiceNumber: stop?.invoice_number ?? r.invoiceNumber ?? null } : null,
        customer: r.customerId ? (customers.get(r.customerId) ?? null) : null,
        rep: rep ? { id: rep.id, code: rep.code ?? null, nameAr: rep.nameAr } : null,
        lines: linesOf[i],
        decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null,
        decidedBy: r.decidedBy ?? null,
        decisionNote: r.decisionNote ?? null,
        order: r.orderVoucherNumber
          ? { id: r.orderVoucherId ?? null, voucherNumber: r.orderVoucherNumber, totalFils: Number(r.orderTotalFils ?? 0) }
          : null,
      };
    });
  }

  private async deciderName(actor: AuthenticatedUser): Promise<string> {
    const rows: Array<{ name: string | null }> = await this.dataSource.query(
      `SELECT name FROM users WHERE id = $1`,
      [actor.sub],
    );
    return rows[0]?.name || actor.userNumber || actor.sub;
  }

  private key(header?: string): string | null {
    const k = (header ?? '').trim();
    return k && k.length <= 255 ? k : null;
  }

  private async timezone(): Promise<string> {
    const rows: Array<{ timezone: string | null }> = await this.dataSource
      .query(`SELECT timezone FROM app_settings WHERE id = 1`)
      .catch(() => []);
    return rows[0]?.timezone || 'Asia/Amman';
  }
}
