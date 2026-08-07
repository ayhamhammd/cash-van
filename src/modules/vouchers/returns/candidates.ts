import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Which sale lines a returned item could have come from.
 *
 * See docs/RETURNS-without-a-sale-voucher.md.
 *
 * ## What is excluded, and why
 *
 * - not `is_posted` — an unposted sale has not happened yet as far as stock and
 *   the ledger are concerned, so nothing on it can come back
 * - `deleted_at IS NOT NULL` — a deleted voucher never validly sold anything
 * - `qty_returned >= item_qty` — nothing left. `GREATEST(..., 0)` floors the
 *   remainder so a legacy over-returned line is excluded rather than appearing
 *   with a negative allowance
 * - `ERP-%` voucher numbers — mirrored from the ERP, not raised here. Returning
 *   against one would create a cash van return whose source the ERP already
 *   owns, and the push would reference a document the ERP did not issue
 */
export interface ReturnCandidate {
  voucherNumber: string;
  lineId: string;
  /**
   * Full UTC timestamp, fixed width (`YYYY-MM-DDTHH:MM:SS.mmm`) so a plain
   * string compare is a chronological compare and the order is timezone-stable.
   */
  inDate: string;
  customerNumber: string | null;
  itemNumber: string;
  itemName: string;
  itemUnitId: string | null;
  unitCode: string | null;
  unitName: string | null;
  /** Quantity on the original sale line. */
  soldQty: number;
  /** Still returnable. Never negative. */
  remaining: number;
  unitPrice: number;
  discountValue: number;
  taxValue: number;
  netTotal: number;
}

export interface CandidateQuery {
  itemNumbers: string[];
  /** Restrict to one customer once identified. Omitted = any customer. */
  customerNumber?: string | null;
  /** Restrict to one salesman's sales — used by the van, and by scoped supervisors. */
  userCode?: string | null;
}

@Injectable()
export class ReturnCandidatesService {
  constructor(private readonly ds: DataSource) {}

  async find(q: CandidateQuery): Promise<ReturnCandidate[]> {
    if (q.itemNumbers.length === 0) return [];

    return this.ds.query<ReturnCandidate[]>(
      `
      SELECT h.voucher_number                          AS "voucherNumber",
             t.id::text                                AS "lineId",
             -- FULL timestamp in UTC, not a calendar date. The ERP uses a date
             -- because its issuedAt IS one; a van raises a dozen sales in a
             -- morning, so truncating to the day makes every sale tie and
             -- NEWEST_FIRST then falls through to the voucher-number tie-break —
             -- which walks them OLDEST first, the exact opposite of the ask.
             -- UTC + fixed width so string comparison is chronological
             -- comparison, and the order never shifts with the server timezone.
             to_char(h.in_date AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS')     AS "inDate",
             h.customer_number                         AS "customerNumber",
             t.item_number                             AS "itemNumber",
             t.item_name                               AS "itemName",
             t.item_unit_id::text                      AS "itemUnitId",
             t.unit_code                               AS "unitCode",
             t.unit_name                               AS "unitName",
             t.item_qty::float8                        AS "soldQty",
             GREATEST(t.item_qty - t.qty_returned, 0)::float8 AS "remaining",
             t.unit_price::float8                      AS "unitPrice",
             t.discount_value::float8                  AS "discountValue",
             -- There is no tax_value column. A line stores "total" (the tax BASE,
             -- post-discount) and "net_total" (tax-inclusive), so the tax is the
             -- difference. Derived this way rather than from tax_percentage
             -- because a tobacco line's tax comes from its own frozen snapshot,
             -- not from the percentage — recomputing would refund a number that
             -- never appeared on the original document.
             (t.net_total - t.total)::float8           AS "taxValue",
             t.net_total::float8                       AS "netTotal"
        FROM voucher_transactions t
        JOIN voucher_headers h ON h.voucher_number = t.voucher_number
       WHERE h.trans_kind = 'SALE'
         AND h.is_posted = true
         AND h.deleted_at IS NULL
         AND h.voucher_number NOT LIKE 'ERP-%'
         AND t.item_number = ANY($1::text[])
         AND t.qty_returned < t.item_qty
         AND ($2::text IS NULL OR h.customer_number = $2::text)
         AND ($3::text IS NULL OR h.user_code = $3::text)
       ORDER BY h.in_date DESC, h.voucher_number, t.id
      `,
      [q.itemNumbers, q.customerNumber ?? null, q.userCode ?? null],
    );
  }
}
