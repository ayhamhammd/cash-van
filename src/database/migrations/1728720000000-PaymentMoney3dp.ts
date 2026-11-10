import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The JOD has three decimals (fils). 1720000000000-VoucherMoney3dp widened the
 * voucher headers and lines and missed the money stored beside them, so every
 * payment row was rounded to the qirsh: RET-204000001 net 1.584 → payment 1.58,
 * INV-106000284 net 15.876 → payment 15.88. Rep cash boxes, the day close's
 * expected cash, receivables, targets and a split sale's ERP receipt all read
 * that rounded figure.
 *
 * Widened to numeric(14,3), like the voucher money:
 *   payments.amount, payment_cheques.amount,
 *   customers.total_debt / total_credit / credit_limit,
 *   item_units.sale_price,
 *   vendors.vendor_credit / vendor_debit,
 *   warehouses.wh_credit_box / wh_debit_box.
 * (Percentages stay (5,2); year_config's legacy yearly totals are untouched.)
 *
 * A scale change rewrites each table under an exclusive lock. The tables are
 * modest, but the lock wait is bounded so a busy server fails the deploy fast
 * instead of queueing every request behind it — re-run it then.
 *
 * Down narrows back to (14,2), which rounds the third decimal away again: the
 * revert is clean structurally, and lossy for any fils written since, by nature.
 */
const COLUMNS: Array<[string, string]> = [
  ['payments', 'amount'],
  ['payment_cheques', 'amount'],
  ['customers', 'total_debt'],
  ['customers', 'total_credit'],
  ['customers', 'credit_limit'],
  ['item_units', 'sale_price'],
  ['vendors', 'vendor_credit'],
  ['vendors', 'vendor_debit'],
  ['warehouses', 'wh_credit_box'],
  ['warehouses', 'wh_debit_box'],
];

export class PaymentMoney3dp1728720000000 implements MigrationInterface {
  name = 'PaymentMoney3dp1728720000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    for (const [table, column] of COLUMNS) {
      await q.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE numeric(14,3)`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    for (const [table, column] of COLUMNS) {
      await q.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE numeric(14,2)`);
    }
  }
}
