import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Where each sale stands with JoFotara.
 *
 * `voucher_headers.jofotara_status` / `jofotara_qr_code` are mirrored from the
 * ERP by the outbox reconciler once the government accepts a document. Nothing
 * in the dashboard showed them, so "did this month actually get filed?" could
 * only be answered by reading the database — and a sale that never reached the
 * authority looked exactly like one that did.
 *
 * Three states, derived rather than stored, because the underlying column is an
 * ERP string and the office needs an answer, not a vocabulary:
 *   EXPORTED — the QR is here. The government has it; nothing to do.
 *   FAILED   — REJECTED / ERROR. Terminal: it will never gain a QR by waiting.
 *   PENDING  — everything else, including a NULL status. Not filed yet.
 * PENDING and FAILED together are "not exported", which is the list the office
 * actually needs; EXPORTED is the reassurance that the rest went through.
 */
export type JoFotaraState = 'EXPORTED' | 'PENDING' | 'FAILED';

export interface JoFotaraVoucherRow {
  id: string;
  voucherNumber: string;
  inDate: string;
  customerNumber: string | null;
  customerName: string | null;
  salesmanCode: string;
  salesmanName: string | null;
  total: number;
  totalTax: number;
  jofotaraStatus: string | null;
  state: JoFotaraState;
}

export interface JoFotaraExportSummary {
  total: number;
  exported: number;
  pending: number;
  failed: number;
}

/** SQL for the derived state — one definition, used by both the list and the counts. */
const STATE_SQL = `CASE
    WHEN h.jofotara_qr_code IS NOT NULL THEN 'EXPORTED'
    WHEN h.jofotara_status IN ('REJECTED', 'ERROR') THEN 'FAILED'
    ELSE 'PENDING'
  END`;

@Injectable()
export class JoFotaraExportService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Rep-scope translation. `visibleRepIds` speaks rep ids; a voucher records the
   * SALESMAN'S LOGIN (`user_code` → `users.user_number`), so the ids have to be
   * walked rep → user before they can filter this table. null in, null out —
   * that is "no restriction" and must not become "restrict to nothing".
   */
  async userCodesForReps(repIds: string[] | null): Promise<string[] | null> {
    if (repIds === null) return null;
    if (repIds.length === 0) return [];
    const rows: Array<{ user_number: string }> = await this.dataSource.query(
      `SELECT u.user_number
         FROM reps r
         JOIN users u ON u.id = r.user_id
        WHERE r.id = ANY($1::uuid[])`,
      [repIds],
    );
    return rows.map((r) => r.user_number);
  }

  /**
   * POSTED SALES TO A CUSTOMER — every part of that is load-bearing.
   *
   * An unposted voucher is not a document yet; flagging it as "not exported"
   * would be an alarm about a draft. Only sales are filed, so transfers and van
   * loads have nothing to do with the authority.
   *
   * And the buyer condition is what makes the number true rather than merely
   * large. The ERP mirrors stock movements into this table as posted SALE rows
   * (ERP-MV-*) with no customer and a zero total — on the restored client data
   * that is 228 of 280 "sales". Counting them reported 235 unexported invoices
   * where the real answer was 13, which is a false alarm big enough to make the
   * screen worth ignoring. A JoFotara e-invoice always has a buyer, so a
   * document without one is not a document the authority ever wanted. Matching
   * on the ERP-MV- prefix would do the same job today and break the first time
   * the ERP renames its movements; the missing buyer is the real distinction.
   */
  private baseWhere(repUserCodes: string[] | null): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    let sql = `h.is_posted = true AND h.trans_kind = 'SALE' AND h.customer_number IS NOT NULL`;
    if (repUserCodes) {
      // An empty scope means "assigned to no rep" — it must return nothing, not
      // everything, so the empty array is passed through rather than ignored.
      params.push(repUserCodes);
      sql += ` AND h.user_code = ANY($${params.length}::text[])`;
    }
    return { sql, params };
  }

  private period(
    from: string | undefined,
    to: string | undefined,
    params: unknown[],
  ): string {
    let sql = '';
    if (from) {
      params.push(from);
      sql += ` AND h.in_date >= $${params.length}::date`;
    }
    if (to) {
      // Inclusive of the whole end day — a filter that silently drops the last
      // day's invoices is worse than no filter.
      params.push(to);
      sql += ` AND h.in_date < ($${params.length}::date + INTERVAL '1 day')`;
    }
    return sql;
  }

  async summary(
    from: string | undefined,
    to: string | undefined,
    repUserCodes: string[] | null,
  ): Promise<JoFotaraExportSummary> {
    const base = this.baseWhere(repUserCodes);
    const period = this.period(from, to, base.params);
    const rows: Array<{ state: JoFotaraState; n: string }> = await this.dataSource.query(
      `SELECT ${STATE_SQL} AS state, count(*)::text AS n
         FROM voucher_headers h
        WHERE ${base.sql}${period}
        GROUP BY 1`,
      base.params,
    );
    const by = new Map(rows.map((r) => [r.state, Number(r.n)]));
    const exported = by.get('EXPORTED') ?? 0;
    const pending = by.get('PENDING') ?? 0;
    const failed = by.get('FAILED') ?? 0;
    return { total: exported + pending + failed, exported, pending, failed };
  }

  async list(
    from: string | undefined,
    to: string | undefined,
    state: JoFotaraState | undefined,
    repUserCodes: string[] | null,
    limit = 100,
    offset = 0,
  ): Promise<{ items: JoFotaraVoucherRow[]; total: number }> {
    const base = this.baseWhere(repUserCodes);
    const period = this.period(from, to, base.params);
    let stateFilter = '';
    if (state) {
      base.params.push(state);
      stateFilter = ` AND ${STATE_SQL} = $${base.params.length}`;
    }

    const countRows: Array<{ n: string }> = await this.dataSource.query(
      `SELECT count(*)::text AS n FROM voucher_headers h
        WHERE ${base.sql}${period}${stateFilter}`,
      base.params,
    );

    const params = [...base.params, limit, offset];
    const rows: Array<{
      id: string;
      voucher_number: string;
      in_date: Date;
      customer_number: string | null;
      customer_name: string | null;
      user_code: string;
      salesman_name: string | null;
      total: string;
      total_tax: string;
      jofotara_status: string | null;
      state: JoFotaraState;
    }> = await this.dataSource.query(
      `SELECT h.id, h.voucher_number, h.in_date, h.customer_number,
              c.name_ar AS customer_name,
              h.user_code,
              COALESCE(r.name_ar, u.name_ar, u.name) AS salesman_name,
              h.total, h.total_tax, h.jofotara_status,
              ${STATE_SQL} AS state
         FROM voucher_headers h
         LEFT JOIN customers c
                ON c.customer_number = h.customer_number AND c.deleted_at IS NULL
         LEFT JOIN users u ON u.user_number = h.user_code
         LEFT JOIN reps  r ON r.user_id = u.id AND r.deleted_at IS NULL
        WHERE ${base.sql}${period}${stateFilter}
        -- Newest first, then the id: in_date alone is not unique (a rep syncs a
        -- day's sales in one burst), and LIMIT/OFFSET over a tied sort silently
        -- skips rows across a page boundary.
        ORDER BY h.in_date DESC, h.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      total: Number(countRows[0]?.n ?? 0),
      items: rows.map((r) => ({
        id: r.id,
        voucherNumber: r.voucher_number,
        inDate: r.in_date.toISOString(),
        customerNumber: r.customer_number,
        customerName: r.customer_name,
        salesmanCode: r.user_code,
        salesmanName: r.salesman_name,
        total: Number(r.total) || 0,
        totalTax: Number(r.total_tax) || 0,
        jofotaraStatus: r.jofotara_status,
        state: r.state,
      })),
    };
  }
}
