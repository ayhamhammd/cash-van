import { DataSource } from 'typeorm';

import { ReportsService } from './reports.service';

/**
 * The voucher summary's payment bucket once Visa exists.
 *
 * Every voucher used to be CASH or CREDIT, so a card sale landed under CASH —
 * and someone reconciling the rep's drawer against the cash filter went looking
 * for money that had gone to the bank through the terminal. CARD is its own
 * bucket now.
 *
 * Real rows, because the bucket is decided by SQL over the payments table: which
 * EXISTS wins when a voucher carries more than one payment type is exactly the
 * kind of thing a mocked repository answers however the test wants.
 */
const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

const P = 'ZZVC';
const DAY = '2026-03-15';

run('voucher summary — the Visa bucket (real DB)', () => {
  let ds: DataSource;
  let reports: ReportsService;
  let repId = '';

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    await q(`DELETE FROM collections WHERE rep_id IN (SELECT id FROM reps WHERE code LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM payments WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM voucher_headers WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
  }

  /** A posted SALE with the given payment rows (type → amount). */
  async function sale(number: string, payments: Array<[string, number]>) {
    const net = payments.reduce((s, [, a]) => s + a, 0);
    await q(
      `INSERT INTO voucher_headers
         (voucher_number, user_code, customer_number, in_date, trans_kind, is_posted, total, net_total)
       VALUES ($1, $2, $3, $4::date, 'SALE', true, $5, $5)`,
      [number, `${P}-REP`, `${P}-C1`, DAY, net],
    );
    for (const [type, amount] of payments) {
      await q(
        `INSERT INTO payments (voucher_number, amount, payment_type) VALUES ($1, $2, $3)`,
        [number, amount, type],
      );
    }
  }

  const summary = (payment: 'ALL' | 'CASH' | 'CARD' | 'CREDIT') =>
    reports.voucherSummary({ from: DAY, to: DAY, repId, payment });

  const numbers = (rows: Array<{ docNumber: string; docType: string }>) =>
    rows.filter((r) => r.docType !== 'COLLECTION').map((r) => r.docNumber).filter((n) => n.startsWith(P)).sort();

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
    await q(`INSERT INTO transaction_kinds (trans_kind, trans_name) VALUES ('SALE', 'Sale') ON CONFLICT DO NOTHING`);
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
    await q(
      `INSERT INTO customers (customer_number, customer_name, name_ar, rep_id) VALUES ($1, 'Shop', 'Shop', $2)`,
      [`${P}-C1`, repId],
    );

    await sale(`${P}-CASH`, [['CASH', 10]]);
    await sale(`${P}-CARD`, [['CARD', 20]]);
    await sale(`${P}-CREDIT`, [['CREDIT', 30]]);
    // Part card, part on account: money is still owed, so it is a credit sale.
    await sale(`${P}-CARD+CREDIT`, [['CARD', 5], ['CREDIT', 5]]);
    await sale(`${P}-CHEQUE`, [['CHEQUE', 7]]);

    await q(
      `INSERT INTO collections (customer_id, rep_id, amount, method, status, collected_at)
       VALUES ((SELECT id FROM customers WHERE customer_number = $1), $2, 1000, 'cash', 'confirmed', $3::date)`,
      [`${P}-C1`, repId, DAY],
    );
  }, 120_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  it('labels a card sale CARD, not CASH', async () => {
    const { rows } = await summary('ALL');
    const card = rows.find((r) => r.docNumber === `${P}-CARD`)!;
    expect(card.payment).toBe('CARD');
  });

  it('the Visa filter returns card sales only', async () => {
    expect(numbers((await summary('CARD')).rows)).toEqual([`${P}-CARD`]);
  });

  it('the cash filter no longer includes card sales', async () => {
    // Cheque stays with cash, as it always was: paid at the time of sale.
    const vouchers = numbers((await summary('CASH')).rows);
    expect(vouchers).toEqual([`${P}-CASH`, `${P}-CHEQUE`].sort());
  });

  it('a part-card, part-credit sale is a credit sale', async () => {
    const vouchers = numbers((await summary('CREDIT')).rows);
    expect(vouchers).toEqual([`${P}-CARD+CREDIT`, `${P}-CREDIT`].sort());
    expect(numbers((await summary('CARD')).rows)).not.toContain(`${P}-CARD+CREDIT`);
  });

  it('the Visa filter shows no collections', async () => {
    // Unhandled, CARD fell through to no condition and listed every collection.
    const { rows } = await summary('CARD');
    expect(rows.some((r) => r.docType === 'COLLECTION')).toBe(false);
  });
});
