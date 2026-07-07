import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ErpOutboxService } from '../erp-sync/erp-outbox.service';
import { CashAccountsService, SettleTransfers } from '../cash-accounts/cash-accounts.service';
import { SalesmanSettlement } from './entities/salesman-settlement.entity';

/** One salesman's End-of-Day cash summary over a period (all money in fils). */
export interface EodRow {
  repId: string | null;
  repCode: string | null;
  repName: string | null;
  collectedCashFils: number;
  collectedChequeFils: number;
  cashSalesFils: number;
  creditSalesFils: number;
  cashReturnsFils: number;
  totalDiscountFils: number;
  expectedCashFils: number; // cashSales + collectedCash − cashReturns
  previousBalanceFils: number; // carried from prior settlements
  totalDueFils: number; // expectedCash + previousBalance
  visitCount: number; // customer visits in range
  noActionVisitCount: number; // visits with no voucher AND no collection that day
  lastSettledTo: string | null;
}

export interface EodResponse {
  from: string;
  to: string;
  rows: EodRow[];
  totals: Omit<EodRow, 'repId' | 'repCode' | 'repName' | 'lastSettledTo'>;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface SettlementRow {
  id: string;
  repId: string;
  repName: string | null;
  repCode: string | null;
  periodFrom: string;
  periodTo: string;
  expectedCashFils: string;
  collectedCashFils: string;
  collectedChequeFils: string;
  cashSalesFils: string;
  creditSalesFils: string;
  cashReturnsFils: string;
  totalDiscountFils: string;
  previousBalanceFils: string;
  receivedFils: string;
  newBalanceFils: string;
  note: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface EodLockResult {
  locked: boolean;
  lockedSince?: string;
  periodFrom?: string;
  periodTo?: string;
  settlementId?: string;
}

export interface BestItemRow {
  itemNumber: string;
  itemName: string;
  qty: string;
  amount: string;
  lines: number;
}

export interface VisitRow {
  id: string;
  visitedAt: Date;
  hadSale: boolean;
  visitNote: string | null;
  customerName: string | null;
  customerNumber: string | null;
  repName: string | null;
}

/** Aggregated KPI payload for the office dashboard home page. */
export interface DashboardOverview {
  date: string;
  sales: {
    todayNet: number;
    todayCount: number;
    yesterdayNet: number;
    returnsTodayNet: number;
    returnsTodayCount: number;
    ordersTodayCount: number;
    openOrdersCount: number;
  };
  payments: { todayTotal: number; todayCash: number; todayCheque: number };
  visits: { today: number; todayWithSale: number; yesterday: number };
  customers: {
    active: number;
    total: number;
    newThisMonth: number;
    totalDebt: number;
    debtors: number;
  };
  cheques: { dueSoonCount: number; dueSoonAmount: number };
  stock: { lowStockCount: number };
  reps: { active: number };
}

export interface TrendPoint {
  date: string;
  salesNet: number;
  salesCount: number;
  returnsNet: number;
  paymentsTotal: number;
}

export interface TopCustomerRow {
  customerNumber: string;
  customerName: string;
  salesNet: number;
  vouchers: number;
  lastSaleAt: Date;
  totalDebt: number;
}

export interface RepLeaderboardRow {
  userCode: string;
  repName: string;
  repCode: string | null;
  salesNet: number;
  vouchers: number;
  customers: number;
  visits: number;
}

export interface LowStockRow {
  itemNumber: string;
  itemName: string;
  qty: number;
  reorderQty: number;
}

/** One [lng, lat] vertex of a trip path (downsampled for drawing). */
export type TripPathPoint = [number, number];

export interface TripRow {
  repId: string;
  repName: string;
  repCode: string | null;
  tripIndex: number;
  startAt: string;
  endAt: string;
  durationMin: number;
  distanceKm: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  points: number;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  /** Downsampled path ([lng, lat] pairs) so the client can draw the trip. */
  path: TripPathPoint[];
}

interface RawPing {
  repId: string;
  repName: string;
  repCode: string | null;
  lat: number;
  lng: number;
  t: number; // epoch ms
}

@Injectable()
export class ReportsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(SalesmanSettlement)
    private readonly settlements: Repository<SalesmanSettlement>,
    private readonly erpOutbox: ErpOutboxService,
    private readonly cashAccounts: CashAccountsService,
  ) {}

  // ── End-of-Day cash reconciliation ─────────────────────────────────────────

  /** Raw per-salesman aggregates for [from, to]. Money in fils. */
  private async eodRows(from: string, to: string, repId?: string): Promise<EodRow[]> {
    const rows: Array<Record<string, string | null>> = await this.ds.query(
      `
      WITH coll AS (
        SELECT rep_id,
          COALESCE(SUM(amount) FILTER (WHERE method='cash'   AND status IN ('confirmed','deposited')),0) AS collected_cash,
          COALESCE(SUM(amount) FILTER (WHERE method='cheque' AND status IN ('confirmed','deposited')),0) AS collected_cheque
        FROM collections
        WHERE collected_at >= $1::date AND collected_at < ($2::date + 1)
        GROUP BY rep_id
      ),
      vp AS (
        SELECT r.id AS rep_id,
          COALESCE(SUM(ROUND(p.amount*1000)) FILTER (WHERE p.payment_type='CASH'   AND h.trans_kind='SALE'),0)   AS cash_sales,
          COALESCE(SUM(ROUND(p.amount*1000)) FILTER (WHERE p.payment_type='CREDIT' AND h.trans_kind='SALE'),0)   AS credit_sales,
          COALESCE(SUM(ROUND(p.amount*1000)) FILTER (WHERE p.payment_type='CASH'   AND h.trans_kind='RETURN'),0) AS cash_returns
        FROM payments p
        JOIN voucher_headers h ON h.voucher_number = p.voucher_number
        JOIN users u ON u.user_number = h.user_code
        JOIN reps  r ON r.user_id = u.id
        WHERE h.is_posted = true AND h.in_date >= $1::date AND h.in_date < ($2::date + 1)
        GROUP BY r.id
      ),
      disc AS (
        SELECT r.id AS rep_id,
          COALESCE(SUM(ROUND(h.total_discount_value*1000)),0) AS total_discount
        FROM voucher_headers h
        JOIN users u ON u.user_number = h.user_code
        JOIN reps  r ON r.user_id = u.id
        WHERE h.is_posted = true AND h.trans_kind='SALE'
          AND h.in_date >= $1::date AND h.in_date < ($2::date + 1)
        GROUP BY r.id
      ),
      bal AS (
        SELECT DISTINCT ON (rep_id) rep_id, new_balance_fils, period_to
        FROM salesman_settlement
        ORDER BY rep_id, created_at DESC
      ),
      vis AS (
        SELECT v.rep_id,
          COUNT(*) AS visit_count,
          COUNT(*) FILTER (
            -- "no action" = visited but no collection AND no posted voucher
            -- for that customer on the same (local) day.
            WHERE NOT EXISTS (
              SELECT 1 FROM collections c
              WHERE c.rep_id = v.rep_id AND c.customer_id = v.customer_id
                AND c.collected_at::date = v.visited_at::date
            )
            AND NOT EXISTS (
              SELECT 1 FROM voucher_headers h2
              JOIN users u2 ON u2.user_number = h2.user_code
              JOIN reps  r2 ON r2.user_id = u2.id
              JOIN customers cu ON cu.customer_number = h2.customer_number
              WHERE r2.id = v.rep_id AND cu.id = v.customer_id
                AND h2.is_posted = true AND h2.in_date::date = v.visited_at::date
            )
          ) AS no_action_count
        FROM customer_visits v
        WHERE v.visited_at >= $1::date AND v.visited_at < ($2::date + 1)
        GROUP BY v.rep_id
      )
      SELECT r.id AS "repId", r.code AS "repCode", r.name_ar AS "repName",
        COALESCE(coll.collected_cash,0)::bigint   AS "collectedCashFils",
        COALESCE(coll.collected_cheque,0)::bigint AS "collectedChequeFils",
        COALESCE(vp.cash_sales,0)::bigint         AS "cashSalesFils",
        COALESCE(vp.credit_sales,0)::bigint       AS "creditSalesFils",
        COALESCE(vp.cash_returns,0)::bigint       AS "cashReturnsFils",
        COALESCE(disc.total_discount,0)::bigint   AS "totalDiscountFils",
        COALESCE(bal.new_balance_fils,0)::bigint  AS "previousBalanceFils",
        COALESCE(vis.visit_count,0)::int          AS "visitCount",
        COALESCE(vis.no_action_count,0)::int      AS "noActionVisitCount",
        to_char(bal.period_to,'YYYY-MM-DD')       AS "lastSettledTo"
      FROM reps r
      LEFT JOIN coll ON coll.rep_id = r.id
      LEFT JOIN vp   ON vp.rep_id   = r.id
      LEFT JOIN disc ON disc.rep_id = r.id
      LEFT JOIN bal  ON bal.rep_id  = r.id
      LEFT JOIN vis  ON vis.rep_id  = r.id
      WHERE r.deleted_at IS NULL
        AND ($3::uuid IS NULL OR r.id = $3::uuid)
        AND (coll.rep_id IS NOT NULL OR vp.rep_id IS NOT NULL
             OR vis.rep_id IS NOT NULL OR COALESCE(bal.new_balance_fils,0) <> 0)
      ORDER BY r.name_ar
      `,
      [from, to, repId ?? null],
    );
    return rows.map((r) => {
      const n = (k: string) => Number(r[k] ?? 0);
      const expectedCashFils =
        n('cashSalesFils') + n('collectedCashFils') - n('cashReturnsFils');
      const previousBalanceFils = n('previousBalanceFils');
      return {
        repId: r.repId,
        repCode: r.repCode,
        repName: r.repName,
        collectedCashFils: n('collectedCashFils'),
        collectedChequeFils: n('collectedChequeFils'),
        cashSalesFils: n('cashSalesFils'),
        creditSalesFils: n('creditSalesFils'),
        cashReturnsFils: n('cashReturnsFils'),
        totalDiscountFils: n('totalDiscountFils'),
        expectedCashFils,
        previousBalanceFils,
        totalDueFils: expectedCashFils + previousBalanceFils,
        visitCount: n('visitCount'),
        noActionVisitCount: n('noActionVisitCount'),
        lastSettledTo: r.lastSettledTo,
      };
    });
  }

  /** End-of-Day report: per-salesman rows + totals. */
  async endOfDay(from: string, to: string, repId?: string): Promise<EodResponse> {
    const rows = await this.eodRows(from, to, repId);
    const sum = (k: keyof EodRow) =>
      rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    return {
      from,
      to,
      rows,
      totals: {
        collectedCashFils: sum('collectedCashFils'),
        collectedChequeFils: sum('collectedChequeFils'),
        cashSalesFils: sum('cashSalesFils'),
        creditSalesFils: sum('creditSalesFils'),
        cashReturnsFils: sum('cashReturnsFils'),
        totalDiscountFils: sum('totalDiscountFils'),
        expectedCashFils: sum('expectedCashFils'),
        previousBalanceFils: sum('previousBalanceFils'),
        totalDueFils: sum('totalDueFils'),
        visitCount: sum('visitCount'),
        noActionVisitCount: sum('noActionVisitCount'),
      },
    };
  }

  /**
   * Record an End-of-Day settlement for one salesman: recompute the period's
   * aggregates server-side (never trust client numbers), write a settlement with
   * new_balance = previous + expected − received, and return it. Doesn't touch
   * any sale/collection.
   */
  async settle(
    dto: { repId: string; from: string; to: string; receivedFils: number; note?: string; transfers?: SettleTransfers },
    userId?: string,
  ): Promise<SalesmanSettlement> {
    if (dto.receivedFils < 0) throw new BadRequestException('receivedFils must be ≥ 0');
    const [row] = await this.eodRows(dto.from, dto.to, dto.repId);
    if (!row) throw new NotFoundException('No activity/rep for this period');
    const newBalance = row.previousBalanceFils + row.expectedCashFils - dto.receivedFils;
    const saved = await this.settlements.save(
      this.settlements.create({
        repId: dto.repId,
        periodFrom: dto.from,
        periodTo: dto.to,
        expectedCashFils: String(row.expectedCashFils),
        collectedCashFils: String(row.collectedCashFils),
        collectedChequeFils: String(row.collectedChequeFils),
        cashSalesFils: String(row.cashSalesFils),
        creditSalesFils: String(row.creditSalesFils),
        cashReturnsFils: String(row.cashReturnsFils),
        totalDiscountFils: String(row.totalDiscountFils),
        previousBalanceFils: String(row.previousBalanceFils),
        receivedFils: String(dto.receivedFils),
        newBalanceFils: String(newBalance),
        note: dto.note ?? null,
        createdByUserId: userId ?? null,
      }),
    );
    // Empty the rep's cash boxes into the chosen destination accounts FIRST — it writes the
    // SETTLEMENT_IN/OUT ledger rows the GL journal is reconstructed from. Best-effort: a
    // failure here leaves the boxes non-zero (visible on the EOD tab) but never voids the
    // settlement record. See docs/SPEC-eod-rep-cash-accounts.md.
    try {
      await this.cashAccounts.settleTransfers(dto.repId, saved.id, dto.transfers ?? {});
    } catch (err) {
      new Logger('Reports').warn(
        `settleTransfers failed for settlement ${saved.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Push accounting to the ERP (best-effort, non-blocking). Prefer the per-box GL journal
    // when the boxes/destinations are ERP-linked; otherwise fall back to the legacy
    // cash-settlement transaction so nothing is double-posted.
    try {
      const journal = await this.cashAccounts.buildSettlementJournal(saved.id);
      await this.erpOutbox.enqueue(journal ? 'REP_SETTLEMENT_JOURNAL' : 'CASH_SETTLEMENT', saved.id);
    } catch {
      await this.erpOutbox.enqueue('CASH_SETTLEMENT', saved.id);
    }
    return saved;
  }

  /** Settlement history with rep name/code (for the dedicated history page). */
  async listSettlements(q: {
    repId?: string;
    from?: string;
    to?: string;
  }): Promise<SettlementRow[]> {
    // DataSource.query() requires PostgreSQL positional params ($1, $2…), not named ones.
    const conditions: string[] = [];
    const params: string[] = [];

    if (q.repId) { params.push(q.repId);  conditions.push(`s.rep_id = $${params.length}`); }
    if (q.from)  { params.push(q.from);   conditions.push(`s.period_to >= $${params.length}`); }
    if (q.to)    { params.push(q.to);     conditions.push(`s.period_from <= $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    return this.ds.query<SettlementRow[]>(
      `SELECT
         s.id,
         s.rep_id                AS "repId",
         r.name_ar               AS "repName",
         r.code                  AS "repCode",
         s.period_from           AS "periodFrom",
         s.period_to             AS "periodTo",
         s.expected_cash_fils    AS "expectedCashFils",
         s.collected_cash_fils   AS "collectedCashFils",
         s.collected_cheque_fils AS "collectedChequeFils",
         s.cash_sales_fils       AS "cashSalesFils",
         s.credit_sales_fils     AS "creditSalesFils",
         s.cash_returns_fils     AS "cashReturnsFils",
         s.total_discount_fils   AS "totalDiscountFils",
         s.previous_balance_fils AS "previousBalanceFils",
         s.received_fils         AS "receivedFils",
         s.new_balance_fils      AS "newBalanceFils",
         s.note,
         s.created_by_user_id    AS "createdByUserId",
         s.created_at            AS "createdAt"
       FROM salesman_settlement s
       LEFT JOIN reps r ON r.id = s.rep_id
       ${where}
       ORDER BY s.created_at DESC
       LIMIT 200`,
      params,
    );
  }

  /**
   * Check whether a rep's day is locked for new transactions.
   * A day is locked when a settlement covers it (period_from ≤ date ≤ period_to).
   * The mobile app calls this before allowing the salesman to create a voucher,
   * return, or collection.
   */
  async getEodLock(repId: string, date?: string): Promise<EodLockResult> {
    const checkDate = date ?? new Date().toISOString().slice(0, 10);
    const rows = await this.ds.query<Array<{
      id: string;
      createdAt: Date;
      periodFrom: string;
      periodTo: string;
    }>>(
      `SELECT id, created_at AS "createdAt", period_from AS "periodFrom", period_to AS "periodTo"
       FROM salesman_settlement
       WHERE rep_id = $1 AND period_from <= $2 AND period_to >= $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [repId, checkDate],
    );
    if (!rows.length) return { locked: false };
    const s = rows[0];
    return {
      locked: true,
      lockedSince: s.createdAt.toISOString(),
      periodFrom: s.periodFrom,
      periodTo: s.periodTo,
      settlementId: s.id,
    };
  }

  /** Best-selling items from posted SALE voucher lines (by quantity), optionally within N days. */
  async bestItems(offset = 0, limit = 25, days?: number): Promise<Paged<BestItemRow>> {
    const dateFilter = days ? `AND h.in_date >= CURRENT_DATE - ($3::int - 1)` : '';
    const params: unknown[] = days ? [offset, limit, days] : [offset, limit];
    const items: BestItemRow[] = await this.ds.query(
      `SELECT t.item_number AS "itemNumber",
              MAX(t.item_name) AS "itemName",
              COALESCE(SUM(t.item_qty::numeric), 0) AS "qty",
              COALESCE(SUM(t.net_total::numeric), 0) AS "amount",
              COUNT(*)::int AS "lines"
         FROM voucher_transactions t
         JOIN voucher_headers h ON h.voucher_number = t.voucher_number
        WHERE h.is_posted = true AND t.trans_kind = 'SALE' ${dateFilter}
        GROUP BY t.item_number
        ORDER BY SUM(t.item_qty::numeric) DESC
        OFFSET $1 LIMIT $2`,
      params,
    );
    const totalRows: Array<{ c: number }> = await this.ds.query(
      `SELECT COUNT(*)::int AS c FROM (
         SELECT 1 FROM voucher_transactions t
         JOIN voucher_headers h ON h.voucher_number = t.voucher_number
         WHERE h.is_posted = true AND t.trans_kind = 'SALE' ${days ? 'AND h.in_date >= CURRENT_DATE - ($1::int - 1)' : ''}
         GROUP BY t.item_number) x`,
      days ? [days] : [],
    );
    return { items, total: totalRows[0]?.c ?? 0 };
  }

  /** Customer visits across all reps, newest first. */
  async visits(offset = 0, limit = 25): Promise<Paged<VisitRow>> {
    const items: VisitRow[] = await this.ds.query(
      `SELECT v.id::text AS id,
              v.visited_at AS "visitedAt",
              v.had_sale AS "hadSale",
              v.visit_note AS "visitNote",
              c.customer_name AS "customerName",
              c.customer_number AS "customerNumber",
              r.name_ar AS "repName"
         FROM customer_visits v
         LEFT JOIN customers c ON c.id = v.customer_id
         LEFT JOIN reps r ON r.id = v.rep_id
        ORDER BY v.visited_at DESC
        OFFSET $1 LIMIT $2`,
      [offset, limit],
    );
    const totalRows: Array<{ c: number }> = await this.ds.query(
      `SELECT COUNT(*)::int AS c FROM customer_visits`,
    );
    return { items, total: totalRows[0]?.c ?? 0 };
  }

  /** Today's customer visits that did NO business (had_sale=false) — who was visited
   *  without a transaction, with customer + rep names (newest first). */
  async noTransactionVisitsToday(): Promise<VisitRow[]> {
    return this.ds.query(
      `SELECT v.id::text AS id,
              v.visited_at AS "visitedAt",
              v.had_sale AS "hadSale",
              v.visit_note AS "visitNote",
              c.customer_name AS "customerName",
              c.customer_number AS "customerNumber",
              r.name_ar AS "repName"
         FROM customer_visits v
         LEFT JOIN customers c ON c.id = v.customer_id
         LEFT JOIN reps r ON r.id = v.rep_id
        WHERE v.had_sale = false AND v.visited_at >= CURRENT_DATE
        ORDER BY v.visited_at DESC`,
    );
  }

  /** One aggregated KPI payload for the dashboard home page (today vs yesterday). */
  async dashboard(): Promise<DashboardOverview> {
    const [salesRows, openOrderRows, payRows, visitRows, custRows, chequeRows, lowStockRows, repRows] =
      await Promise.all([
        this.ds.query(
          `SELECT
              COALESCE(SUM(net_total::numeric) FILTER (WHERE trans_kind = 'SALE'   AND in_date >= CURRENT_DATE), 0)::float8 AS "todayNet",
              COUNT(*)                         FILTER (WHERE trans_kind = 'SALE'   AND in_date >= CURRENT_DATE)::int        AS "todayCount",
              COALESCE(SUM(net_total::numeric) FILTER (WHERE trans_kind = 'SALE'   AND in_date <  CURRENT_DATE), 0)::float8 AS "yesterdayNet",
              COALESCE(SUM(net_total::numeric) FILTER (WHERE trans_kind = 'RETURN' AND in_date >= CURRENT_DATE), 0)::float8 AS "returnsTodayNet",
              COUNT(*)                         FILTER (WHERE trans_kind = 'RETURN' AND in_date >= CURRENT_DATE)::int        AS "returnsTodayCount",
              COUNT(*)                         FILTER (WHERE trans_kind = 'ORDER'  AND in_date >= CURRENT_DATE)::int        AS "ordersTodayCount"
            FROM voucher_headers
           WHERE is_posted = true AND deleted_at IS NULL
             AND in_date >= CURRENT_DATE - 1`,
        ),
        this.ds.query(
          `SELECT COUNT(*)::int AS c
             FROM voucher_headers
            WHERE trans_kind = 'ORDER' AND is_fulfilled = false AND deleted_at IS NULL`,
        ),
        this.ds.query(
          // "Collected today" = actual collection receipts (the collections table),
          // NOT sales-voucher payment lines. amount is fils → JOD major. Only money
          // actually collected (confirmed/deposited), excluding pending/bounced.
          `SELECT
              COALESCE(SUM(amount), 0)::float8 / 1000                                   AS "todayTotal",
              COALESCE(SUM(amount) FILTER (WHERE method = 'cash'),   0)::float8 / 1000   AS "todayCash",
              COALESCE(SUM(amount) FILTER (WHERE method = 'cheque'), 0)::float8 / 1000   AS "todayCheque"
            FROM collections
           WHERE status IN ('confirmed','deposited') AND collected_at >= CURRENT_DATE`,
        ),
        this.ds.query(
          `SELECT
              COUNT(*) FILTER (WHERE visited_at >= CURRENT_DATE)::int                 AS "today",
              COUNT(*) FILTER (WHERE visited_at >= CURRENT_DATE AND had_sale)::int    AS "todayWithSale",
              COUNT(*) FILTER (WHERE visited_at <  CURRENT_DATE)::int                 AS "yesterday"
            FROM customer_visits
           WHERE visited_at >= CURRENT_DATE - 1`,
        ),
        this.ds.query(
          `SELECT
              COUNT(*) FILTER (WHERE is_active)::int AS "active",
              COUNT(*)::int AS "total",
              COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE))::int AS "newThisMonth",
              COALESCE(SUM(total_debt::numeric) FILTER (WHERE total_debt::numeric > 0), 0)::float8 AS "totalDebt",
              COUNT(*) FILTER (WHERE total_debt::numeric > 0)::int AS "debtors"
            FROM customers
           WHERE deleted_at IS NULL`,
        ),
        this.ds.query(
          `SELECT COUNT(*)::int AS "dueSoonCount",
                  COALESCE(SUM(amount::numeric), 0)::float8 AS "dueSoonAmount"
             FROM payment_cheques
            WHERE deleted_at IS NULL
              AND due_date >= CURRENT_DATE AND due_date < CURRENT_DATE + 8`,
        ),
        this.ds.query(
          `SELECT COUNT(*)::int AS c FROM (
             SELECT b.item_number
               FROM item_balance b
               JOIN item_cart ic ON ic.item_number = b.item_number
              WHERE ic.deleted_at IS NULL AND ic.is_active = true AND ic.reorder_qty > 0
              GROUP BY b.item_number, ic.reorder_qty
             HAVING COALESCE(SUM(b.qty), 0) <= ic.reorder_qty) x`,
        ),
        this.ds.query(
          `SELECT COUNT(*)::int AS c FROM reps WHERE deleted_at IS NULL AND is_active = true`,
        ),
      ]);

    const s = salesRows[0] ?? {};
    const p = payRows[0] ?? {};
    const v = visitRows[0] ?? {};
    const c = custRows[0] ?? {};
    const q = chequeRows[0] ?? {};
    return {
      date: new Date().toISOString().slice(0, 10),
      sales: {
        todayNet: s.todayNet ?? 0,
        todayCount: s.todayCount ?? 0,
        yesterdayNet: s.yesterdayNet ?? 0,
        returnsTodayNet: s.returnsTodayNet ?? 0,
        returnsTodayCount: s.returnsTodayCount ?? 0,
        ordersTodayCount: s.ordersTodayCount ?? 0,
        openOrdersCount: openOrderRows[0]?.c ?? 0,
      },
      payments: {
        todayTotal: p.todayTotal ?? 0,
        todayCash: p.todayCash ?? 0,
        todayCheque: p.todayCheque ?? 0,
      },
      visits: {
        today: v.today ?? 0,
        todayWithSale: v.todayWithSale ?? 0,
        yesterday: v.yesterday ?? 0,
      },
      customers: {
        active: c.active ?? 0,
        total: c.total ?? 0,
        newThisMonth: c.newThisMonth ?? 0,
        totalDebt: c.totalDebt ?? 0,
        debtors: c.debtors ?? 0,
      },
      cheques: {
        dueSoonCount: q.dueSoonCount ?? 0,
        dueSoonAmount: q.dueSoonAmount ?? 0,
      },
      stock: { lowStockCount: lowStockRows[0]?.c ?? 0 },
      reps: { active: repRows[0]?.c ?? 0 },
    };
  }

  /** Daily sales / returns / payments series for the last N days (zero-filled). */
  async salesTrend(days = 30): Promise<TrendPoint[]> {
    return this.ds.query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS "date",
              COALESCE(s."salesNet", 0)     AS "salesNet",
              COALESCE(s."salesCount", 0)   AS "salesCount",
              COALESCE(s."returnsNet", 0)   AS "returnsNet",
              COALESCE(p."paymentsTotal", 0) AS "paymentsTotal"
         FROM generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, interval '1 day') AS d(day)
         LEFT JOIN (
            SELECT in_date::date AS day,
                   COALESCE(SUM(net_total::numeric) FILTER (WHERE trans_kind = 'SALE'),   0)::float8 AS "salesNet",
                   COUNT(*)                         FILTER (WHERE trans_kind = 'SALE')::int          AS "salesCount",
                   COALESCE(SUM(net_total::numeric) FILTER (WHERE trans_kind = 'RETURN'), 0)::float8 AS "returnsNet"
              FROM voucher_headers
             WHERE is_posted = true AND deleted_at IS NULL
               AND in_date >= CURRENT_DATE - ($1::int - 1)
             GROUP BY in_date::date) s ON s.day = d.day
         LEFT JOIN (
            -- collection receipts per day (fils → JOD major), not sales-voucher payments
            SELECT collected_at::date AS day,
                   COALESCE(SUM(amount), 0)::float8 / 1000 AS "paymentsTotal"
              FROM collections
             WHERE status IN ('confirmed','deposited')
               AND collected_at >= CURRENT_DATE - ($1::int - 1)
             GROUP BY collected_at::date) p ON p.day = d.day
        ORDER BY d.day`,
      [days],
    );
  }

  /** Top customers by posted SALE net total over the last N days. */
  async topCustomers(days = 30, limit = 10): Promise<TopCustomerRow[]> {
    return this.ds.query(
      `SELECT c.customer_number AS "customerNumber",
              c.customer_name   AS "customerName",
              COALESCE(SUM(h.net_total::numeric), 0)::float8 AS "salesNet",
              COUNT(*)::int     AS "vouchers",
              MAX(h.in_date)    AS "lastSaleAt",
              c.total_debt::float8 AS "totalDebt"
         FROM voucher_headers h
         JOIN customers c ON c.customer_number = h.customer_number
        WHERE h.is_posted = true AND h.deleted_at IS NULL
          AND h.trans_kind = 'SALE'
          AND h.in_date >= CURRENT_DATE - ($1::int - 1)
        GROUP BY c.customer_number, c.customer_name, c.total_debt
        ORDER BY SUM(h.net_total::numeric) DESC
        LIMIT $2`,
      [days, limit],
    );
  }

  /** Rep performance leaderboard (sales, vouchers, distinct customers, visits) over N days. */
  async repLeaderboard(days = 30, limit = 10): Promise<RepLeaderboardRow[]> {
    return this.ds.query(
      `SELECT u.user_number AS "userCode",
              COALESCE(r.name_ar, u.name) AS "repName",
              r.code AS "repCode",
              COALESCE(SUM(h.net_total::numeric), 0)::float8 AS "salesNet",
              COUNT(*)::int AS "vouchers",
              COUNT(DISTINCT h.customer_number)::int AS "customers",
              COALESCE((SELECT COUNT(*)::int FROM customer_visits v
                         WHERE v.rep_id = r.id
                           AND v.visited_at >= CURRENT_DATE - ($1::int - 1)), 0) AS "visits"
         FROM voucher_headers h
         JOIN users u ON u.user_number = h.user_code
         LEFT JOIN reps r ON r.user_id = u.id AND r.deleted_at IS NULL
        WHERE h.is_posted = true AND h.deleted_at IS NULL
          AND h.trans_kind = 'SALE'
          AND h.in_date >= CURRENT_DATE - ($1::int - 1)
        GROUP BY u.user_number, u.name, r.id, r.name_ar, r.code
        ORDER BY SUM(h.net_total::numeric) DESC
        LIMIT $2`,
      [days, limit],
    );
  }

  /** Items at or below their reorder quantity (total qty across all stores). */
  async lowStock(limit = 25): Promise<LowStockRow[]> {
    return this.ds.query(
      `SELECT b.item_number AS "itemNumber",
              MAX(b.item_name) AS "itemName",
              COALESCE(SUM(b.qty), 0)::float8 AS "qty",
              ic.reorder_qty AS "reorderQty"
         FROM item_balance b
         JOIN item_cart ic ON ic.item_number = b.item_number
        WHERE ic.deleted_at IS NULL AND ic.is_active = true AND ic.reorder_qty > 0
        GROUP BY b.item_number, ic.reorder_qty
       HAVING COALESCE(SUM(b.qty), 0) <= ic.reorder_qty
        ORDER BY COALESCE(SUM(b.qty), 0)::float8 / NULLIF(ic.reorder_qty, 0)::float8 ASC
        LIMIT $1`,
      [limit],
    );
  }

  /**
   * Segment each rep's GPS pings for a given day into trips. A trip is a run of
   * movement; it ends when the van sits still (within STOP_RADIUS_M for
   * STOP_DWELL_MS) or the signal drops (gap > GAP_MS). Tiny/noise segments are
   * discarded. Works for both real (parking gaps) and continuous-ping data.
   */
  async repTrips(date: string, repId?: string): Promise<TripRow[]> {
    const params: unknown[] = [date];
    let repFilter = '';
    if (repId) {
      params.push(repId);
      repFilter = `AND e.rep_id = $2`;
    }
    const pings: RawPing[] = await this.ds.query(
      `SELECT e.rep_id AS "repId",
              COALESCE(r.name_ar, r.code, '—') AS "repName",
              r.code AS "repCode",
              e.lat AS "lat",
              e.lng AS "lng",
              (EXTRACT(EPOCH FROM e.recorded_at) * 1000)::float8 AS "t"
         FROM rep_location_events e
         JOIN reps r ON r.id = e.rep_id
        WHERE e.recorded_at >= $1::date
          AND e.recorded_at <  ($1::date + INTERVAL '1 day')
          ${repFilter}
        ORDER BY e.rep_id, e.recorded_at ASC`,
      params,
    );

    const STOP_RADIUS_M = 80;
    const STOP_DWELL_MS = 5 * 60_000;
    const GAP_MS = 15 * 60_000;
    const MIN_TRIP_M = 150;

    // Group pings per rep (already ordered by rep then time).
    const byRep = new Map<string, RawPing[]>();
    for (const p of pings) {
      const list = byRep.get(p.repId);
      if (list) list.push(p);
      else byRep.set(p.repId, [p]);
    }

    const trips: TripRow[] = [];
    for (const list of byRep.values()) {
      const repTripCount = { n: 0 };
      let segment: RawPing[] = [];
      let anchor: RawPing | null = null;

      const flush = () => {
        const built = this.buildTrip(segment, repTripCount, MIN_TRIP_M);
        if (built) trips.push(built);
        segment = [];
        anchor = null;
      };

      for (const p of list) {
        if (segment.length === 0) {
          segment = [p];
          anchor = p;
          continue;
        }
        const prev = segment[segment.length - 1]!;
        if (p.t - prev.t > GAP_MS) {
          flush();
          segment = [p];
          anchor = p;
          continue;
        }
        const fromAnchor = haversineMeters(anchor!.lat, anchor!.lng, p.lat, p.lng);
        if (fromAnchor <= STOP_RADIUS_M) {
          // Still parked near the anchor — a confirmed dwell ends the trip.
          if (p.t - anchor!.t >= STOP_DWELL_MS) {
            flush();
            segment = [p];
            anchor = p;
          } else {
            segment.push(p);
          }
        } else {
          // Moved on — advance the anchor and keep building the trip.
          anchor = p;
          segment.push(p);
        }
      }
      flush();
    }

    // Newest trips first across the whole fleet.
    trips.sort((a, b) => (a.startAt < b.startAt ? 1 : -1));
    return trips;
  }

  private buildTrip(
    seg: RawPing[],
    repTripCount: { n: number },
    minTripM: number,
  ): TripRow | null {
    if (seg.length < 2) return null;
    // Ignore physically impossible jumps (GPS glitches / overlapping sources):
    // a van won't exceed ~140 km/h, so faster legs are noise and don't count.
    const MAX_PLAUSIBLE_KMH = 140;
    let distM = 0;
    let maxSpeedKmh = 0;
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1]!;
      const b = seg[i]!;
      const d = haversineMeters(a.lat, a.lng, b.lat, b.lng);
      const dtH = (b.t - a.t) / 3_600_000;
      if (dtH <= 0) continue;
      const legKmh = d / 1000 / dtH;
      if (legKmh > MAX_PLAUSIBLE_KMH) continue; // skip the glitch leg
      distM += d;
      maxSpeedKmh = Math.max(maxSpeedKmh, legKmh);
    }
    if (distM < minTripM) return null;

    const first = seg[0]!;
    const last = seg[seg.length - 1]!;
    const durationMin = (last.t - first.t) / 60_000;
    const distanceKm = distM / 1000;
    const avgSpeedKmh = durationMin > 0 ? distanceKm / (durationMin / 60) : 0;

    // Downsample the path to ≤120 vertices for drawing.
    const step = Math.max(1, Math.ceil(seg.length / 120));
    const path: TripPathPoint[] = [];
    for (let i = 0; i < seg.length; i += step) {
      path.push([round6(seg[i]!.lng), round6(seg[i]!.lat)]);
    }
    if (path[path.length - 1]![0] !== round6(last.lng)) {
      path.push([round6(last.lng), round6(last.lat)]);
    }

    repTripCount.n += 1;
    return {
      repId: first.repId,
      repName: first.repName,
      repCode: first.repCode,
      tripIndex: repTripCount.n,
      startAt: new Date(first.t).toISOString(),
      endAt: new Date(last.t).toISOString(),
      durationMin: Math.round(durationMin * 10) / 10,
      distanceKm: Math.round(distanceKm * 100) / 100,
      avgSpeedKmh: Math.round(avgSpeedKmh * 10) / 10,
      maxSpeedKmh: Math.round(maxSpeedKmh * 10) / 10,
      points: seg.length,
      startLat: round6(first.lat),
      startLng: round6(first.lng),
      endLat: round6(last.lat),
      endLng: round6(last.lng),
      path,
    };
  }
}

/** Great-circle distance in metres. */
function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
