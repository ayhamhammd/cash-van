import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { SalesTarget, TargetMetric } from './entities/sales-target.entity';
import { UpsertTargetDto } from './dto/upsert-target.dto';

export interface TargetRow {
  repId: string;
  repCode: string | null;
  repName: string;
  targetId: string | null;
  metric: TargetMetric | null;
  targetValue: number | null; // fils (AMOUNT) or units (QTY)
  notes: string | null;
  actualAmount: number; // fils — van sales PLUS ERP-raised invoices
  /** The van's own posted sales. */
  actualVanAmount: number; // fils
  /**
   * Invoices the office raised in the ERP for this rep's customers.
   *
   * Split out rather than folded away so a rep can see WHERE their figure came
   * from. "My target says 8,000 and I only sold 5,000" has an answer when the
   * other 3,000 is named.
   */
  actualErpAmount: number; // fils
  actualQty: number; // units
  progressPct: number | null; // actual-vs-target on the target's metric
  remaining: number | null; // target − actual on the target's metric (≥ 0); null if no target

  // ── What the salesman is measured against, and paid on ────────────────────
  /** What they should SELL this month, fils. Null = no sales target set. */
  salesTargetFils: number | null;
  /** What they should COLLECT this month, fils. Null = no collection target. */
  collectionTargetFils: number | null;
  /** Commission rates as percentages (0–100). */
  cashPct: number;
  creditPct: number;
  collectionPct: number;

  // ── What they actually did ────────────────────────────────────────────────
  /** Sales paid for at the time — van cash/cheque/transfer plus ERP cash. */
  cashSalesFils: number;
  /** Sales left on account — van CREDIT plus every ERP invoice not marked CASH. */
  creditSalesFils: number;
  /** cash + credit. What the sales target is measured against. */
  totalSalesFils: number;
  /** Confirmed collections. What the collection target is measured against. */
  collectedFils: number;

  // ── What that earns ───────────────────────────────────────────────────────
  commissionOnCashFils: number;
  commissionOnCreditFils: number;
  commissionOnCollectionFils: number;
  /** The three added together — what is actually owed for the month. */
  commissionTotalFils: number;

  /** Achieved-vs-target on each, 0–∞. Null when that target is not set. */
  salesProgressPct: number | null;
  collectionProgressPct: number | null;
}

/** A target row for a specific month — used by the salesman's target history. */
export interface TargetHistoryRow extends TargetRow {
  year: number;
  month: number;
}

/**
 * The LEFT JOIN subqueries that tally a rep's actuals for the period
 * ($1 = month start, $2 = next-month start).
 *
 * `sa` = van sale amount in fils, `sq` = van item qty. Both key on
 * users.user_number == voucher_headers.user_code.
 *
 * `ea` = invoices the OFFICE raised in the ERP for customers this rep services.
 * A shop invoiced in the ERP produces no voucher here, so without this a rep
 * could serve a customer all month and show zero against their target. It keys
 * on the rep stored on the mirrored invoice, resolved when it was synced — not
 * on the customer's assignment today, which would rewrite last month's figure
 * the moment a customer changed hands.
 *
 * DOUBLE COUNTING IS PREVENTED UPSTREAM, NOT HERE. Invoices cash-van pushed to
 * the ERP come back marked VAN_SALES and are never mirrored, so `sa` and `ea`
 * cannot describe the same sale. See ErpSyncService.applyErpInvoice.
 *
 * ONLY THE AMOUNT METRIC IS AFFECTED. `sq` counts item quantities from voucher
 * lines; the mirror holds invoice headers, not lines, so a QTY target still
 * measures what the van itself moved.
 */
const ACTUALS_JOINS = `
  LEFT JOIN (
    SELECT h.user_code, COALESCE(SUM(ROUND(h.total * 1000)), 0)::bigint AS amount_fils
    FROM voucher_headers h
    WHERE h.trans_kind = 'SALE' AND h.is_posted = true
      AND h.in_date >= $1::date AND h.in_date < $2::date
    GROUP BY h.user_code
  ) sa ON sa.user_code = u.user_number
  LEFT JOIN (
    SELECT h.user_code, COALESCE(SUM(CAST(vt.item_qty AS numeric)), 0) AS qty
    FROM voucher_headers h
    JOIN voucher_transactions vt ON vt.voucher_number = h.voucher_number AND vt.trans_kind = 'SALE'
    WHERE h.trans_kind = 'SALE' AND h.is_posted = true
      AND h.in_date >= $1::date AND h.in_date < $2::date
    GROUP BY h.user_code
  ) sq ON sq.user_code = u.user_number
  LEFT JOIN (
    SELECT ei.rep_id,
           COALESCE(SUM(ei.total_fils), 0)::bigint AS amount_fils,
           COALESCE(SUM(CASE WHEN ei.payment_type = 'CASH' THEN ei.total_fils ELSE 0 END), 0)::bigint AS cash_fils,
           COALESCE(SUM(CASE WHEN ei.payment_type = 'CASH' THEN 0 ELSE ei.total_fils END), 0)::bigint AS credit_fils
    FROM erp_invoices ei
    WHERE ei.deleted_at IS NULL
      AND ei.issued_at >= $1::date AND ei.issued_at < $2::date
    GROUP BY ei.rep_id
  ) ea ON ea.rep_id = r.id
  LEFT JOIN (
    -- Van sales split by how they were PAID FOR, because cash and credit earn
    -- different rates. A voucher's payment rows say which: anything booked
    -- CREDIT is the credit part, everything else (cash, cheque, transfer, card)
    -- is money that arrived at the time of sale.
    --
    -- Split on the PAYMENTS, not the voucher, because one sale can be part cash
    -- and part on account — paying the whole of a half-paid sale at the cash
    -- rate is a real overpayment, and it is invisible in a monthly total.
    SELECT h.user_code,
           SUM(CASE WHEN p.payment_type = 'CREDIT' THEN 0 ELSE ROUND(p.amount::numeric * 1000) END)::bigint AS cash_fils,
           SUM(CASE WHEN p.payment_type = 'CREDIT' THEN ROUND(p.amount::numeric * 1000) ELSE 0 END)::bigint AS credit_fils
      FROM voucher_headers h
      JOIN payments p ON p.voucher_number = h.voucher_number
     WHERE h.trans_kind = 'SALE' AND h.is_posted = true AND h.deleted_at IS NULL
       AND h.in_date >= $1::date AND h.in_date < $2::date
     GROUP BY h.user_code
  ) sp ON sp.user_code = u.user_number
  LEFT JOIN (
    -- What the salesman actually COLLECTED.
    --
    -- 'confirmed' and 'deposited' only, and the vocabulary is LOWERCASE — the
    -- table's own check constraint says so, and comparing against 'CONFIRMED'
    -- matches nothing at all, which reads as a salesman who collected zero.
    --
    -- 'pending' is money that has not arrived and 'bounced' is money that came
    -- back; paying commission on either is paying for money not received.
    SELECT c.rep_id, COALESCE(SUM(ROUND(c.amount::numeric * 1000)), 0)::bigint AS amount_fils
      FROM collections c
     WHERE c.status IN ('confirmed', 'deposited')
       AND c.collected_at >= $1::date AND c.collected_at < $2::date
     GROUP BY c.rep_id
  ) co ON co.rep_id = r.id
`;

const SELECT_COLS = `
  r.id                              AS "repId",
  r.code                            AS "repCode",
  COALESCE(r.name_ar, r.name_en)    AS "repName",
  t.id                              AS "targetId",
  t.metric                          AS "metric",
  t.target_value                    AS "targetValue",
  t.notes                           AS "notes",
  (COALESCE(sa.amount_fils, 0) + COALESCE(ea.amount_fils, 0)) AS "actualAmount",
  COALESCE(sa.amount_fils, 0)       AS "actualVanAmount",
  COALESCE(ea.amount_fils, 0)       AS "actualErpAmount",
  COALESCE(sq.qty, 0)               AS "actualQty",
  t.sales_target_fils               AS "salesTargetFils",
  t.collection_target_fils          AS "collectionTargetFils",
  COALESCE(t.cash_pct, 0)           AS "cashPct",
  COALESCE(t.credit_pct, 0)         AS "creditPct",
  COALESCE(t.collection_pct, 0)     AS "collectionPct",
  COALESCE(sp.cash_fils, 0)         AS "cashSalesFils",
  -- An ERP invoice with no payment type counts as CREDIT: the lower rate.
  -- Guessing in the salesman's favour is how commission gets overpaid quietly.
  (COALESCE(sp.credit_fils, 0) + COALESCE(ea.credit_fils, 0)) AS "creditSalesFils",
  COALESCE(ea.cash_fils, 0)         AS "erpCashFils",
  COALESCE(co.amount_fils, 0)       AS "collectedFils"
`;

@Injectable()
export class TargetsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(SalesTarget) private readonly repo: Repository<SalesTarget>,
  ) {}

  /** All active salesmen with their target for the month + actual sales + progress. */
  async list(
    year: number,
    month: number,
    visibleRepIds: string[] | null = null,
  ): Promise<TargetRow[]> {
    const [start, end] = periodBounds(year, month);

    // A scoped supervisor sees their own team's targets only — theirs is a
    // league table of their people, not the company's. `null` = unrestricted;
    // an empty array means "sees nobody" and correctly returns no rows.
    const rows: Array<Record<string, string | null>> = await this.ds.query(
      `
      SELECT ${SELECT_COLS}
      FROM reps r
      LEFT JOIN users u ON u.id = r.user_id
      LEFT JOIN sales_targets t ON t.rep_id = r.id AND t.year = $3 AND t.month = $4
      ${ACTUALS_JOINS}
      WHERE r.is_active = true AND r.deleted_at IS NULL
        AND ($5::uuid[] IS NULL OR r.id = ANY($5::uuid[]))
      ORDER BY COALESCE(r.name_ar, r.name_en)
      `,
      [start, end, year, month, visibleRepIds],
    );

    return rows.map(mapRow);
  }

  /**
   * A single salesman's target + actuals + progress for a month. Used by the
   * mobile app (`GET /targets/me`) and the dashboard rep drawer. Returns a row
   * even when no target is set (metric/targetValue/progressPct are null).
   */
  async getForRep(repId: string, year: number, month: number): Promise<TargetRow> {
    const [start, end] = periodBounds(year, month);

    const rows: Array<Record<string, string | null>> = await this.ds.query(
      `
      SELECT ${SELECT_COLS}
      FROM reps r
      LEFT JOIN users u ON u.id = r.user_id
      LEFT JOIN sales_targets t ON t.rep_id = r.id AND t.year = $3 AND t.month = $4
      ${ACTUALS_JOINS}
      WHERE r.id = $5
      LIMIT 1
      `,
      [start, end, year, month, repId],
    );

    if (rows.length === 0) throw new NotFoundException('Salesman not found.');
    return mapRow(rows[0]);
  }

  /**
   * A salesman's target history: the last `months` months (most-recent first),
   * each with the target + actual sales + progress. Used by the mobile app
   * (`GET /targets/me/history`). Reuses `getForRep` per month.
   */
  async historyForRep(repId: string, months: number): Promise<TargetHistoryRow[]> {
    const n = Math.max(1, Math.min(24, Math.floor(months) || 6));
    const now = new Date();
    const out: TargetHistoryRow[] = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const row = await this.getForRep(repId, year, month);
      out.push({ ...row, year, month });
    }
    return out;
  }

  /** Create or replace a rep's target for a (year, month). */
  async upsert(dto: UpsertTargetDto): Promise<SalesTarget> {
    const existing = await this.repo.findOne({
      where: { repId: dto.repId, year: dto.year, month: dto.month },
    });
    const row = existing ?? this.repo.create({ repId: dto.repId, year: dto.year, month: dto.month });

    // Every field is optional and applied only when SENT, so a caller editing
    // one rate does not silently clear a target it never mentioned. `null` is
    // meaningful and distinct from absent: it clears the target.
    if (dto.metric !== undefined) row.metric = (dto.metric as TargetMetric) ?? null;
    if (dto.targetValue !== undefined) {
      row.targetValue = dto.targetValue == null ? null : String(dto.targetValue);
    }
    if (dto.salesTargetFils !== undefined) {
      row.salesTargetFils = dto.salesTargetFils == null ? null : String(dto.salesTargetFils);
    }
    if (dto.collectionTargetFils !== undefined) {
      row.collectionTargetFils =
        dto.collectionTargetFils == null ? null : String(dto.collectionTargetFils);
    }
    if (dto.cashPct !== undefined) row.cashPct = String(dto.cashPct);
    if (dto.creditPct !== undefined) row.creditPct = String(dto.creditPct);
    if (dto.collectionPct !== undefined) row.collectionPct = String(dto.collectionPct);
    if (dto.notes !== undefined) row.notes = dto.notes ?? null;
    return this.repo.save(row);
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    const res = await this.repo.delete(id);
    if (!res.affected) throw new NotFoundException('Target not found.');
    return { deleted: true };
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** [monthStart, nextMonthStart) as YYYY-MM-DD strings for the SQL date range. */
function periodBounds(year: number, month: number): [string, string] {
  const start = `${year}-${pad(month)}-01`;
  const end = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  return [start, end];
}

/** Shape a raw SQL row into a TargetRow, computing progress on the target metric. */
function mapRow(r: Record<string, string | null>): TargetRow {
  const metric = (r.metric as TargetMetric | null) ?? null;
  const targetValue = r.targetValue != null ? Number(r.targetValue) : null;
  const actualAmount = Number(r.actualAmount ?? 0);
  const actualVanAmount = Number(r.actualVanAmount ?? 0);
  const actualErpAmount = Number(r.actualErpAmount ?? 0);
  const actualQty = Number(r.actualQty ?? 0);
  const actualForMetric = metric === 'QTY' ? actualQty : actualAmount;
  const progressPct =
    targetValue && targetValue > 0
      ? Math.round((actualForMetric / targetValue) * 100)
      : null;
  const remaining =
    targetValue != null ? Math.max(0, targetValue - actualForMetric) : null;
  return {
    repId: r.repId as string,
    repCode: r.repCode ?? null,
    repName: (r.repName as string) ?? '',
    targetId: r.targetId ?? null,
    metric,
    targetValue,
    notes: r.notes ?? null,
    actualAmount,
    actualVanAmount,
    actualErpAmount,
    actualQty,
    progressPct,
    remaining,
    ...commission(r),
  };
}

/**
 * What the salesman sold, collected, and is owed for it.
 *
 * Commission is computed from the rates ON THE TARGET ROW, not from the rep — a
 * rate that changes in March must not retrospectively re-price January, and a
 * month's row is the record of what was agreed for that month.
 *
 * Rounded once per component rather than on the sum: each is a separate line on
 * a commission sheet and has to add up to the total printed beside it.
 */
function commission(r: Record<string, string | null>) {
  const n = (k: string) => Number(r[k] ?? 0) || 0;

  const cashSalesFils = n('cashSalesFils') + n('erpCashFils');
  const creditSalesFils = n('creditSalesFils');
  const totalSalesFils = cashSalesFils + creditSalesFils;
  const collectedFils = n('collectedFils');

  const cashPct = n('cashPct');
  const creditPct = n('creditPct');
  const collectionPct = n('collectionPct');

  const pctOf = (amount: number, pct: number) => Math.round((amount * pct) / 100);
  const commissionOnCashFils = pctOf(cashSalesFils, cashPct);
  const commissionOnCreditFils = pctOf(creditSalesFils, creditPct);
  const commissionOnCollectionFils = pctOf(collectedFils, collectionPct);

  const salesTargetFils = r.salesTargetFils != null ? Number(r.salesTargetFils) : null;
  const collectionTargetFils =
    r.collectionTargetFils != null ? Number(r.collectionTargetFils) : null;

  // A zero target is "not set", not "already achieved": dividing by it would
  // report either infinity or a triumphant 100% for a salesman who sold nothing.
  const progress = (actual: number, target: number | null) =>
    target && target > 0 ? Math.round((actual / target) * 100) : null;

  return {
    salesTargetFils,
    collectionTargetFils,
    cashPct,
    creditPct,
    collectionPct,
    cashSalesFils,
    creditSalesFils,
    totalSalesFils,
    collectedFils,
    commissionOnCashFils,
    commissionOnCreditFils,
    commissionOnCollectionFils,
    commissionTotalFils:
      commissionOnCashFils + commissionOnCreditFils + commissionOnCollectionFils,
    salesProgressPct: progress(totalSalesFils, salesTargetFils),
    collectionProgressPct: progress(collectedFils, collectionTargetFils),
  };
}
