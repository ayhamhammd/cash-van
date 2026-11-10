import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Put back the fils `payments.amount` lost while it was numeric(14,2)
 * (fixed by migration PaymentMoney3dp).
 *
 * Only where the answer is certain: a voucher with ONE payment row whose amount
 * is exactly its net total rounded to the qirsh — RET-204000001 net 1.584 with a
 * payment of 1.58 — gets the net total back (1.584). That row can only be the
 * whole voucher, rounded; nothing else produces it.
 *
 * Everything else is left alone and counted: a voucher with several payment
 * rows (a split sale — which row lost the fil cannot be known), or one row
 * that differs from the net total by more than rounding (a part payment, an
 * older document). A person decides those.
 *
 * Explicit, never automatic — it is an admin endpoint, so it runs on a server
 * only when someone calls it there.
 */
@Injectable()
export class PaymentFilsRepairService {
  private readonly logger = new Logger(PaymentFilsRepairService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** The predicate both the dry run and the repair use, so they cannot disagree. */
  private static readonly SAFE = `
        h.voucher_number = p.voucher_number
    AND p.deleted_at IS NULL AND h.deleted_at IS NULL
    AND p.amount <> h.net_total
    AND p.amount = ROUND(h.net_total, 2)
    AND (SELECT count(*) FROM payments p2
          WHERE p2.voucher_number = p.voucher_number AND p2.deleted_at IS NULL) = 1`;

  async repair(opts: { dryRun?: boolean } = {}): Promise<{
    dryRun: boolean;
    repaired: number;
    sample: string[];
    leftAlone: { multiPayment: number; singleNotRounding: number };
  }> {
    const dryRun = opts.dryRun === true;
    let numbers: string[];
    if (dryRun) {
      const rows: Array<{ voucher_number: string }> = await this.ds.query(
        `SELECT p.voucher_number FROM payments p, voucher_headers h WHERE ${PaymentFilsRepairService.SAFE}
          ORDER BY p.voucher_number`,
      );
      numbers = rows.map((r) => r.voucher_number);
    } else {
      // One statement: the predicate is re-checked on every row it writes.
      const res: unknown = await this.ds.query(
        `UPDATE payments p SET amount = h.net_total, updated_at = now()
           FROM voucher_headers h
          WHERE ${PaymentFilsRepairService.SAFE}
          RETURNING p.voucher_number`,
      );
      // TypeORM hands an UPDATE … RETURNING back as [rows, count].
      const rows = (Array.isArray(res) && Array.isArray(res[0]) ? res[0] : res) as Array<{ voucher_number: string }>;
      numbers = rows.map((r) => r.voucher_number).sort();
      if (numbers.length) this.logger.warn(`Repaired the fils of ${numbers.length} payment(s)`);
    }

    // What still disagrees with its voucher, and was deliberately not touched.
    const [left]: Array<{ multi: number; single: number }> = await this.ds.query(
      `SELECT count(*) FILTER (WHERE n > 1)::int AS multi,
              count(*) FILTER (WHERE n = 1)::int AS single
         FROM (SELECT h.voucher_number, h.net_total, count(p.id) AS n, SUM(p.amount) AS paid
                 FROM voucher_headers h
                 JOIN payments p ON p.voucher_number = h.voucher_number AND p.deleted_at IS NULL
                WHERE h.deleted_at IS NULL
                GROUP BY h.voucher_number, h.net_total) x
        WHERE x.paid <> x.net_total
          ${dryRun ? `AND NOT (x.n = 1 AND x.paid = ROUND(x.net_total, 2))` : ''}`,
    );
    return {
      dryRun,
      repaired: numbers.length,
      sample: numbers.slice(0, 20),
      leftAlone: { multiPayment: left?.multi ?? 0, singleNotRounding: left?.single ?? 0 },
    };
  }
}
