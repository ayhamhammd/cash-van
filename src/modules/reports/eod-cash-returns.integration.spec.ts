/**
 * Real-DB: in the rep's End of Day, a CREDIT return is the customer's credit and
 * takes nothing out of the drawer; a CASH return paid the customer out of the
 * van and comes off expected cash (docs/SPEC-cash-returns.md).
 *
 * Intake keeps a return CASH only for a salesman allowed to refund cash, so a
 * stored CASH return here is money that left the van.
 *
 * Runs when DB_NAME is set, like the other report integration specs.
 */
import { DataSource } from 'typeorm';

import { ReportsService } from './reports.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

const P = 'ZZEODRET';
const DAY = '2026-03-10';

run('End of Day — cash and credit returns (real DB)', () => {
  let ds: DataSource;
  let reports: ReportsService;
  let repId = '';

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    await q(`DELETE FROM payments WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM voucher_headers WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
  }

  async function voucher(number: string, kind: 'SALE' | 'RETURN', amount: number, paymentType: string) {
    await q(
      `INSERT INTO voucher_headers
         (voucher_number, user_code, customer_number, in_date, trans_kind, is_posted, total, net_total)
       VALUES ($1, $2, $3, $4::date, $5, true, $6, $6)`,
      [number, `${P}-REP`, `${P}-C1`, DAY, kind, amount],
    );
    await q(
      `INSERT INTO payments (voucher_number, amount, payment_type, payment_date) VALUES ($1, $2, $3, $4::date)`,
      [number, amount, paymentType, DAY],
    );
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'cashvan',
      database: process.env.DB_NAME as string,
      entities: [],
      synchronize: false,
    });
    await ds.initialize();
    reports = new ReportsService(ds, null as never, null as never, null as never);

    await purge();
    const [u] = await q(
      `INSERT INTO users (user_number, name, password_hash, user_type) VALUES ($1, 'Rep', 'x', 'SALES') RETURNING id`,
      [`${P}-REP`],
    );
    const [r] = await q(
      `INSERT INTO reps (user_id, code, name_ar, is_active) VALUES ($1, $2, 'Rep', true) RETURNING id`,
      [u.id, `${P}-REP`],
    );
    repId = r.id;
    await q(`INSERT INTO customers (customer_number, customer_name, name_ar) VALUES ($1, 'Shop', 'Shop')`, [`${P}-C1`]);

    await voucher(`${P}-S1`, 'SALE', 40, 'CASH');
    await voucher(`${P}-R1`, 'RETURN', 10, 'CASH');   // paid back from the van
    await voucher(`${P}-R2`, 'RETURN', 5, 'CREDIT');  // left on the customer's account
  });

  afterAll(async () => {
    await purge();
    await ds.destroy();
  });

  it('takes a cash return off what he owes, and never a credit one', async () => {
    const eod = await reports.endOfDay(DAY, DAY, repId);
    const row = eod.rows.find((r) => r.repId === repId);
    expect(row).toBeDefined();
    expect(row!.cashSalesFils).toBe(40_000);
    expect(row!.cashRefundsFils).toBe(10_000);
    expect(row!.expectedCashFils).toBe(30_000);
  });

  it('still shows every return, split by how the customer was paid back', async () => {
    const eod = await reports.endOfDay(DAY, DAY, repId);
    const row = eod.rows.find((r) => r.repId === repId)!;
    expect(row.cashReturnsFils).toBe(15_000);
    expect(row.returnsCreditFils).toBe(5_000);
    expect(eod.totals.cashRefundsFils).toBeGreaterThanOrEqual(10_000);
  });
});
