import { DataSource } from 'typeorm';
import { unpostedDebtByCustomer, withUnposted } from './unposted-debt';

/**
 * Real DB: the ERP mirror puts back what the ERP has not posted yet.
 *
 * The case that was reported: a salesman collects a shop's whole debt, the ERP
 * has not posted the receipt yet, the mirror writes the ERP's figure over the
 * column — and the debt is back, so the handset refuses his next credit sale.
 *
 * Pins, on rows of its own:
 *  - a receipt the ERP has not posted lowers the figure; a posted one does not
 *    (the ERP counts it then — never both);
 *  - a credit sale not yet posted raises it, a credit return lowers it;
 *  - pending and bounced receipts, cash sales, ERP-raised invoices and receipts
 *    mirrored in from the ERP are not counted;
 *  - old never-queued history is not added back, and a failed push ages out.
 *
 * Skipped without DB_NAME. Uses one existing rep and user; creates and removes
 * everything else under the ZZUNP prefix.
 */
const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;
const P = 'ZZUNP';

run('unposted debt put back on the ERP mirror (real DB)', () => {
  let ds: DataSource;
  let repId = '';
  let userCode = '';
  let custId = '';
  const CUST = `${P}-C1`;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    await q(`DELETE FROM erp_id_map WHERE local_id IN (SELECT id::text FROM collections WHERE customer_id IN (SELECT id FROM customers WHERE customer_number LIKE $1))`, [`${P}%`]);
    await q(`DELETE FROM erp_outbox WHERE ref LIKE $1 OR ref IN (SELECT id::text FROM collections WHERE customer_id IN (SELECT id FROM customers WHERE customer_number LIKE $1))`, [`${P}%`]);
    await q(`DELETE FROM collections WHERE customer_id IN (SELECT id FROM customers WHERE customer_number LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM payments WHERE voucher_number LIKE $1`, [`%${P}%`]);
    await q(`DELETE FROM voucher_headers WHERE voucher_number LIKE $1`, [`%${P}%`]);
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
  }

  /** A receipt of `jod`, `ageHours` old, with an outbox row in `outbox` (or none). */
  async function receipt(jod: number, opts: { status?: string; outbox?: string | null; ageHours?: number; fromErp?: boolean } = {}) {
    const [{ id }] = await q(
      `INSERT INTO collections (rep_id, customer_id, amount, method, status, created_at)
       VALUES ($1, $2, $3, 'cash', $4, now() - make_interval(hours => $5)) RETURNING id`,
      [repId, custId, Math.round(jod * 1000), opts.status ?? 'confirmed', opts.ageHours ?? 0],
    );
    if (opts.outbox) {
      await q(`INSERT INTO erp_outbox (kind, ref, status) VALUES ('PAYMENT', $1, $2)`, [String(id), opts.outbox]);
    }
    if (opts.fromErp) {
      await q(`INSERT INTO erp_id_map (entity, erp_id, local_id) VALUES ('receipt', $1, $2)`, [`${P}-${id}`, String(id)]);
    }
  }

  let n = 0;
  /** A voucher with one payment row of `type` for `jod`. */
  async function voucher(kind: 'SALE' | 'RETURN', jod: number, opts: { type?: string; outbox?: string | null; ageHours?: number; number?: string } = {}) {
    n += 1;
    const no = opts.number ?? `${P}-V${n}`;
    await q(
      `INSERT INTO voucher_headers (voucher_number, user_code, trans_kind, customer_number, in_date, is_posted)
       VALUES ($1, $2, $3, $4, now() - make_interval(hours => $5), true)`,
      [no, userCode, kind, CUST, opts.ageHours ?? 0],
    );
    await q(`INSERT INTO payments (voucher_number, amount, payment_type) VALUES ($1, $2, $3)`, [no, jod.toFixed(3), opts.type ?? 'CREDIT']);
    if (opts.outbox) {
      const outboxKind = kind === 'RETURN' ? 'SALES_RETURN' : 'SALE_INVOICE';
      await q(`INSERT INTO erp_outbox (kind, ref, status) VALUES ($1, $2, $3)`, [outboxKind, no, opts.outbox]);
    }
  }

  const unposted = async () => (await unpostedDebtByCustomer(ds, [custId])).get(custId) ?? 0;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'cashvan',
      database: process.env.DB_NAME as string,
      synchronize: false,
    });
    await ds.initialize();
    await purge();
    repId = (await q(`SELECT id FROM reps LIMIT 1`))[0].id;
    userCode = (await q(`SELECT user_number FROM users LIMIT 1`))[0].user_number;
    custId = (await q(
      `INSERT INTO customers (customer_number, customer_name, name_ar) VALUES ($1, 'ZZ Unposted', 'ZZ Unposted') RETURNING id`,
      [CUST],
    ))[0].id;
  }, 60_000);

  afterAll(async () => {
    if (!ds) return;
    await purge();
    await ds.destroy();
  });

  beforeEach(async () => {
    await q(`DELETE FROM erp_id_map WHERE local_id IN (SELECT id::text FROM collections WHERE customer_id = $1)`, [custId]);
    await q(`DELETE FROM erp_outbox WHERE ref LIKE $1 OR ref IN (SELECT id::text FROM collections WHERE customer_id = $2)`, [`${P}%`, custId]);
    await q(`DELETE FROM collections WHERE customer_id = $1`, [custId]);
    await q(`DELETE FROM payments WHERE voucher_number LIKE $1`, [`%${P}%`]);
    await q(`DELETE FROM voucher_headers WHERE voucher_number LIKE $1`, [`%${P}%`]);
  });

  it('keeps a receipt the ERP has not posted yet — the reported case', async () => {
    // Owed 500, collected all of it; the ERP still says 500.
    await receipt(500, { outbox: 'pending' });
    expect(await unposted()).toBeCloseTo(-500, 2);
    expect(withUnposted(500, await unposted())).toBe('0.000');
  });

  it('counts a receipt once: by cash-van until the ERP posts it, then by the ERP', async () => {
    await receipt(200, { outbox: 'posted' });
    expect(await unposted()).toBe(0);
  });

  it('keeps a receipt whose push failed, and one not queued yet', async () => {
    await receipt(50, { outbox: 'dead_letter' });
    await receipt(20, { outbox: null, ageHours: 1 });
    expect(await unposted()).toBeCloseTo(-70, 2);
  });

  it('ignores receipts that have not moved the debt, or that the ERP already holds', async () => {
    await receipt(10, { status: 'pending', outbox: null });
    await receipt(10, { status: 'bounced', outbox: 'pending' });
    await receipt(10, { outbox: null, fromErp: true });
    expect(await unposted()).toBe(0);
  });

  it('adds an unposted credit sale and takes off an unposted credit return', async () => {
    await voucher('SALE', 120, { outbox: 'pending' });
    await voucher('RETURN', 20, { outbox: 'failed' });
    expect(await unposted()).toBeCloseTo(100, 2);
  });

  it('ignores cash sales, posted sales and invoices the ERP raised itself', async () => {
    await voucher('SALE', 90, { type: 'CASH', outbox: 'pending' });
    await voucher('SALE', 90, { outbox: 'posted' });
    await voucher('SALE', 90, { outbox: null, number: `ERP-${P}-INV1` });
    expect(await unposted()).toBe(0);
  });

  it('does not add back old history, and lets a failed push age out', async () => {
    await receipt(30, { outbox: null, ageHours: 48 });           // never queued, two days old
    await voucher('SALE', 30, { outbox: null, ageHours: 48 });
    await receipt(30, { outbox: 'dead_letter', ageHours: 31 * 24 }); // failed, a month ago
    expect(await unposted()).toBe(0);
  });

  it('reads the whole book at once for the interval pull', async () => {
    await receipt(500, { outbox: 'pending' });
    const all = await unpostedDebtByCustomer(ds);
    expect(all.get(custId)).toBeCloseTo(-500, 2);
  });
});
