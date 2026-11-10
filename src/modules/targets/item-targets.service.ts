import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SettingsService } from '../settings/settings.service';
import type { ItemTargetMetric } from './entities/sales-item-target.entity';
import { INCLUDE_TAX_SQL, POSTED_IN_PERIOD, VOUCHER_REP_JOIN, periodBounds } from './target-rules';
import type { PutItemTargetsDto } from './dto/item-targets.dto';

/** One item target with what was achieved — the shape every endpoint answers. */
export interface ItemTargetLine {
  id: string;
  repId: string;
  repCode: string | null;
  repName: string;
  year: number;
  month: number;
  itemNumber: string;
  itemNameAr: string | null;
  itemNameEn: string | null;
  unitNameAr: string | null;
  unitNameEn: string | null;
  metric: ItemTargetMetric;
  targetQty: number | null;
  targetFils: number | null;
  achievedQty: number | null;
  achievedFils: number | null;
  /** achieved ÷ target × 100, rounded like the sales target's progress. */
  pct: number;
  notes: string | null;
}

export const ITEM_TARGETS_OFF = 'Item targets are turned off in Program features';

/**
 * A line's quantity in the item's BASE unit.
 *
 * Lines written by the vouchers path already hold it: item_qty =
 * qty_of_unit × the resolved item_units.qty, with unit_base_qty = that factor.
 * Lines mirrored from the ERP (an invoiced order's `ERP-` sale, an approved
 * delivery return's `ERP-RET-` voucher) record the ERP SKU's quantity with
 * unit_base_qty 1; when that SKU is a packaging unit (a carton), the quantity is
 * cartons, so it is multiplied by the unit's qty here.
 */
export const BASE_QTY_SQL = `
  (CASE WHEN iu.id IS NOT NULL AND COALESCE(iu.qty, 1) > 1
             AND COALESCE(vt.unit_base_qty, 1) = 1
             AND COALESCE(vt.qty_of_unit, vt.item_qty) = vt.item_qty
        THEN vt.item_qty * iu.qty
        ELSE vt.item_qty END)`;

/** What one line adds: + for a sale line, − for a return line. */
const LINE_SIGN = `(CASE WHEN vt.trans_kind = 'RETURN' THEN -1 ELSE 1 END)`;

/** Integer pct like the monthly target's progress; 0 for a non-positive target. */
export function pctOf(achieved: number, target: number | null): number {
  return target && target > 0 ? Math.round((achieved / target) * 100) : 0;
}

/**
 * Item targets (Program features → item targets).
 *
 * Achievement for (rep, month, item) is the posted SALE lines of the item minus
 * its posted RETURN lines in the month, under the SAME rules as the monthly
 * sales target (targets.service.ts — its pieces are imported, not copied):
 * the rep whose login is the voucher's user_code (so an office invoice made
 * from the rep's ORDER — the ERP- sale — is his, and an approved delivery
 * return — ERP-RET- — comes off the ORIGINAL salesman, as it does for net
 * sales), posted vouchers dated in the month, and targets_include_tax deciding
 * whether an AMOUNT counts the line with or without tax.
 *
 * Measured, NOT paid: commission does not read item targets in this version.
 */
@Injectable()
export class ItemTargetsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
  ) {}

  async enabled(): Promise<boolean> {
    return this.settings.itemTargetsEnabled();
  }

  /** Every item target of the month (optionally one rep / a visible set) with its achievement. */
  async lines(year: number, month: number, opts: { repId?: string; repIds?: string[] | null } = {}): Promise<ItemTargetLine[]> {
    const [start, end] = periodBounds(year, month);
    const rows: Array<Record<string, string | number | null>> = await this.ds.query(
      `
      WITH t AS (
        SELECT * FROM sales_item_targets
         WHERE year = $3 AND month = $4
           AND ($5::uuid IS NULL OR rep_id = $5::uuid)
           AND ($6::uuid[] IS NULL OR rep_id = ANY($6::uuid[]))
      ),
      done AS (
        SELECT r.id AS rep_id, vt.item_number,
               SUM(${LINE_SIGN} * ${BASE_QTY_SQL}) AS qty,
               SUM(${LINE_SIGN} * ROUND(
                     (CASE WHEN ${INCLUDE_TAX_SQL} THEN vt.net_total ELSE vt.total END)::numeric * 1000)) AS fils
          FROM voucher_headers h
          JOIN voucher_transactions vt
            ON vt.voucher_number = h.voucher_number AND vt.deleted_at IS NULL
           AND vt.trans_kind IN ('SALE', 'RETURN')
          LEFT JOIN item_units iu ON iu.id = vt.item_unit_id
          ${VOUCHER_REP_JOIN}
         WHERE h.trans_kind IN ('SALE', 'RETURN') AND ${POSTED_IN_PERIOD} AND h.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM t WHERE t.rep_id = r.id AND t.item_number = vt.item_number)
         GROUP BY r.id, vt.item_number
      )
      SELECT t.id, t.rep_id AS "repId", r.code AS "repCode", COALESCE(r.name_ar, r.name_en, '') AS "repName",
             t.year, t.month, t.item_number AS "itemNumber",
             ic.name_ar AS "itemNameAr", ic.name_en AS "itemNameEn",
             COALESCE(un.name_ar, ic.unit_of_measure) AS "unitNameAr",
             COALESCE(un.name_en, un.name_ar, ic.unit_of_measure) AS "unitNameEn",
             t.metric, t.target_qty AS "targetQty", t.target_fils AS "targetFils", t.notes,
             COALESCE(done.qty, 0) AS "achievedQty", COALESCE(done.fils, 0) AS "achievedFils"
        FROM t
        JOIN reps r ON r.id = t.rep_id
        LEFT JOIN item_cart ic ON ic.item_number = t.item_number
        LEFT JOIN units un ON un.code = ic.unit_of_measure
        LEFT JOIN done ON done.rep_id = t.rep_id AND done.item_number = t.item_number
       ORDER BY COALESCE(r.name_ar, r.name_en), t.item_number
      `,
      [start, end, year, month, opts.repId ?? null, opts.repIds ?? null],
    );
    return rows.map((r) => {
      const metric = r.metric as ItemTargetMetric;
      const targetQty = r.targetQty != null ? Number(r.targetQty) : null;
      const targetFils = r.targetFils != null ? Number(r.targetFils) : null;
      const achievedQty = Math.round(Number(r.achievedQty) * 1000) / 1000;
      const achievedFils = Number(r.achievedFils);
      return {
        id: String(r.id),
        repId: String(r.repId),
        repCode: (r.repCode as string | null) ?? null,
        repName: String(r.repName ?? ''),
        year: Number(r.year),
        month: Number(r.month),
        itemNumber: String(r.itemNumber),
        itemNameAr: (r.itemNameAr as string | null) ?? null,
        itemNameEn: (r.itemNameEn as string | null) ?? null,
        unitNameAr: (r.unitNameAr as string | null) ?? null,
        unitNameEn: (r.unitNameEn as string | null) ?? null,
        metric,
        targetQty: metric === 'QTY' ? targetQty : null,
        targetFils: metric === 'AMOUNT' ? targetFils : null,
        achievedQty: metric === 'QTY' ? achievedQty : null,
        achievedFils: metric === 'AMOUNT' ? achievedFils : null,
        pct: metric === 'QTY' ? pctOf(achievedQty, targetQty) : pctOf(achievedFils, targetFils),
        notes: (r.notes as string | null) ?? null,
      };
    });
  }

  /** GET /targets/items — empty while the switch is off. */
  async list(year: number, month: number, repId?: string, visibleRepIds: string[] | null = null): Promise<{ items: ItemTargetLine[] }> {
    if (!(await this.enabled())) return { items: [] };
    return { items: await this.lines(year, month, { repId, repIds: visibleRepIds }) };
  }

  /**
   * PUT /targets/items — replace one rep's item targets for a month: the lines
   * sent are upserted, the ones left out are deleted. All or nothing.
   */
  async replace(dto: PutItemTargetsDto, actorId: string | null): Promise<{ items: ItemTargetLine[] }> {
    await this.assertOn();
    const problems = validateLines(dto.lines);
    if (problems.length) {
      throw new BadRequestException({ code: 'ITEM_TARGET_INVALID', message: problems.join('; '), problems });
    }
    const rep: Array<{ id: string }> = await this.ds.query(`SELECT id FROM reps WHERE id = $1 AND deleted_at IS NULL`, [dto.repId]);
    if (!rep.length) throw new NotFoundException({ code: 'REP_NOT_FOUND', message: `Salesman ${dto.repId} not found` });
    const numbers = [...new Set(dto.lines.map((l) => l.itemNumber.trim()))];
    if (numbers.length) {
      const known: Array<{ item_number: string }> = await this.ds.query(
        `SELECT item_number FROM item_cart WHERE item_number = ANY($1::text[]) AND deleted_at IS NULL`,
        [numbers],
      );
      const have = new Set(known.map((k) => k.item_number));
      const unknown = numbers.filter((n) => !have.has(n));
      if (unknown.length) {
        throw new BadRequestException({
          code: 'ITEM_TARGET_INVALID',
          message: `Unknown item(s): ${unknown.join(', ')}`,
          problems: unknown.map((n) => `${n}: unknown item`),
        });
      }
    }

    await this.ds.transaction(async (em) => {
      await em.query(
        `DELETE FROM sales_item_targets
          WHERE rep_id = $1 AND year = $2 AND month = $3 AND NOT (item_number = ANY($4::text[]))`,
        [dto.repId, dto.year, dto.month, numbers],
      );
      for (const l of dto.lines) {
        await em.query(
          `INSERT INTO sales_item_targets (rep_id, year, month, item_number, metric, target_qty, target_fils, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (rep_id, year, month, item_number) DO UPDATE
              SET metric = EXCLUDED.metric, target_qty = EXCLUDED.target_qty,
                  target_fils = EXCLUDED.target_fils, notes = EXCLUDED.notes, updated_at = now()`,
          [
            dto.repId,
            dto.year,
            dto.month,
            l.itemNumber.trim(),
            l.metric,
            l.metric === 'QTY' ? l.targetQty : null,
            l.metric === 'AMOUNT' ? l.targetFils : null,
            l.notes?.trim() || null,
            actorId,
          ],
        );
      }
    });
    return { items: await this.lines(dto.year, dto.month, { repId: dto.repId }) };
  }

  /** DELETE /targets/items/:id */
  async remove(id: string): Promise<{ deleted: true }> {
    await this.assertOn();
    const res: unknown = await this.ds.query(`DELETE FROM sales_item_targets WHERE id = $1 RETURNING id`, [id]);
    const rows = (Array.isArray(res) && Array.isArray(res[0]) ? res[0] : res) as unknown[];
    if (!rows.length) throw new NotFoundException({ code: 'ITEM_TARGET_NOT_FOUND', message: 'Item target not found' });
    return { deleted: true };
  }

  private async assertOn(): Promise<void> {
    if (!(await this.enabled())) throw new ForbiddenException({ code: 'FEATURE_DISABLED', message: ITEM_TARGETS_OFF });
  }
}

/**
 * The PUT's rules, each failure named: the metric matches the value, the value
 * is positive, a quantity has at most 3 decimals, an amount is whole fils, and
 * an item appears once.
 */
export function validateLines(
  lines: Array<{ itemNumber: string; metric: string; targetQty?: number | null; targetFils?: number | null }>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const n = (l.itemNumber ?? '').trim();
    if (!n) {
      out.push('an item number is required');
      continue;
    }
    if (seen.has(n)) out.push(`${n}: listed twice`);
    seen.add(n);
    if (l.metric === 'QTY') {
      if (l.targetFils != null) out.push(`${n}: a QTY target takes targetQty, not targetFils`);
      if (l.targetQty == null || !(l.targetQty > 0)) out.push(`${n}: targetQty must be greater than 0`);
      else if (Math.abs(l.targetQty * 1000 - Math.round(l.targetQty * 1000)) > 1e-6) {
        out.push(`${n}: targetQty has more than 3 decimals`);
      }
    } else if (l.metric === 'AMOUNT') {
      if (l.targetQty != null) out.push(`${n}: an AMOUNT target takes targetFils, not targetQty`);
      if (l.targetFils == null || !(l.targetFils > 0)) out.push(`${n}: targetFils must be greater than 0`);
      else if (!Number.isInteger(l.targetFils)) out.push(`${n}: targetFils must be whole fils`);
    } else {
      out.push(`${n}: metric must be QTY or AMOUNT`);
    }
  }
  return out;
}
