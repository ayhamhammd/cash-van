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
  actualAmount: number; // fils
  actualQty: number; // units
  progressPct: number | null; // actual-vs-target on the target's metric
}

/**
 * The two LEFT JOIN subqueries that tally a rep's posted SALE actuals for the
 * period ($1 = month start, $2 = next-month start). `sa` = amount in fils,
 * `sq` = item qty. Both key on users.user_number == voucher_headers.user_code.
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
`;

const SELECT_COLS = `
  r.id                              AS "repId",
  r.code                            AS "repCode",
  COALESCE(r.name_ar, r.name_en)    AS "repName",
  t.id                              AS "targetId",
  t.metric                          AS "metric",
  t.target_value                    AS "targetValue",
  t.notes                           AS "notes",
  COALESCE(sa.amount_fils, 0)       AS "actualAmount",
  COALESCE(sq.qty, 0)               AS "actualQty"
`;

@Injectable()
export class TargetsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(SalesTarget) private readonly repo: Repository<SalesTarget>,
  ) {}

  /** All active salesmen with their target for the month + actual sales + progress. */
  async list(year: number, month: number): Promise<TargetRow[]> {
    const [start, end] = periodBounds(year, month);

    const rows: Array<Record<string, string | null>> = await this.ds.query(
      `
      SELECT ${SELECT_COLS}
      FROM reps r
      LEFT JOIN users u ON u.id = r.user_id
      LEFT JOIN sales_targets t ON t.rep_id = r.id AND t.year = $3 AND t.month = $4
      ${ACTUALS_JOINS}
      WHERE r.is_active = true AND r.deleted_at IS NULL
      ORDER BY COALESCE(r.name_ar, r.name_en)
      `,
      [start, end, year, month],
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

  /** Create or replace a rep's target for a (year, month). */
  async upsert(dto: UpsertTargetDto): Promise<SalesTarget> {
    const existing = await this.repo.findOne({
      where: { repId: dto.repId, year: dto.year, month: dto.month },
    });
    const row = existing ?? this.repo.create({ repId: dto.repId, year: dto.year, month: dto.month });
    row.metric = dto.metric as TargetMetric;
    row.targetValue = String(dto.targetValue);
    row.notes = dto.notes ?? null;
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
  const actualQty = Number(r.actualQty ?? 0);
  const actualForMetric = metric === 'QTY' ? actualQty : actualAmount;
  const progressPct =
    targetValue && targetValue > 0
      ? Math.round((actualForMetric / targetValue) * 100)
      : null;
  return {
    repId: r.repId as string,
    repCode: r.repCode ?? null,
    repName: (r.repName as string) ?? '',
    targetId: r.targetId ?? null,
    metric,
    targetValue,
    notes: r.notes ?? null,
    actualAmount,
    actualQty,
    progressPct,
  };
}
