/**
 * Real-DB: in the rep's End of Day, a return is the customer's credit — never
 * cash excused.
 *
 * A return used to be recorded, and subtracted, as a cash refund whenever the
 * sale it reversed was a cash sale. The business rule is the opposite: no money
 * is handed back on a return. So a rep who took 40 in cash owes 40, however many
 * returns he booked — and the returns are still shown, whatever they were
 * recorded as (an old phone may still send a cash refund).
 *
 * Runs when DB_NAME is set, like the other report integration specs.
 */
import { DataSource } from 'typeorm';

import { ReportsService } from './reports.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

const P = 'ZZEODRET';
const DAY = '2026-03-10';

run('End of Day — returns are credit (real DB)', () => {
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
    await voucher(`${P}-R1`, 'RETURN', 10, 'CASH');   // an old phone's "cash refund"
    await voucher(`${P}-R2`, 'RETURN', 5, 'CREDIT');  // how every return is stored now
  });

  afterAll(async () => {
    await purge();
    await ds.destroy();
  });

  it('owes every dinar of cash he took — returns are not taken off it', async () => {
    const eod = await reports.endOfDay(DAY, DAY, repId);
    const row = eod.rows.find((r) => r.repId === repId);
    expect(row).toBeDefined();
    expect(row!.cashSalesFils).toBe(40_000);
    expect(row!.expectedCashFils).toBe(40_000);
  });

  it('still shows every return, whatever it was recorded as', async () => {
    const eod = await reports.endOfDay(DAY, DAY, repId);
    const row = eod.rows.find((r) => r.repId === repId)!;
    expect(row.cashReturnsFils).toBe(15_000);
  });
});
