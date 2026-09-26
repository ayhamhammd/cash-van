/**
 * Real-DB tests for the salesman sales report and the target figure.
 *
 * Both measure what the salesman sold FROM THE VAN. Invoices the office raised
 * in the ERP are not his selling and are left out of both, even for customers
 * he services. The fixtures still create office invoices, so these tests prove
 * they are ignored rather than merely absent.
 *
 *  - every active salesman appears, including the ones who sold nothing;
 *  - unposted vouchers, returns and other dates never count;
 *  - the documents behind a row add up to that row.
 *
 * Skipped unless DB_HOST/DB_NAME point at a database with the schema applied.
 */
import { DataSource } from 'typeorm';

import { ReportsService } from './reports.service';
import { TargetsService } from '../targets/targets.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

const P = 'ZZSM';                       // fixture prefix — everything is purged by it
const FROM = '2026-03-01';
const TO = '2026-03-31';

run('salesman sales (real DB)', () => {
  let ds: DataSource;
  let reports: ReportsService;
  let targets: TargetsService;

  let samiRepId = '';
  let lailaRepId = '';
  let quietRepId = '';
  let samiCustomerId = '';

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    // Children before parents, and everything keyed off the fixture prefix so a
    // real row can never be caught by it.
    await q(`DELETE FROM erp_invoices WHERE erp_id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM voucher_transactions WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM voucher_headers WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM sales_targets WHERE rep_id IN (SELECT id FROM reps WHERE code LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
  }

  async function makeRep(code: string, name: string) {
    const [u] = await q(
      `INSERT INTO users (user_number, name, password_hash, user_type)
       VALUES ($1, $2, 'x', 'SALES') RETURNING id`,
      [code, name],
    );
    const [r] = await q(
      `INSERT INTO reps (user_id, code, name_ar, is_active) VALUES ($1, $2, $3, true) RETURNING id`,
      [u.id, code, name],
    );
    return { userCode: code, repId: r.id as string };
  }

  async function makeCustomer(number: string, repId: string | null) {
    const [c] = await q(
      `INSERT INTO customers (customer_number, customer_name, name_ar, rep_id)
       VALUES ($1, $2, $2, $3) RETURNING id`,
      [number, `${number} shop`, repId],
    );
    return c.id as string;
  }

  /** A posted van SALE voucher. `total` and `net` are major units, as stored. */
  async function makeVoucher(opts: {
    number: string; userCode: string; customerNumber: string;
    date: string; net: number; total?: number; posted?: boolean; kind?: string;
  }) {
    await q(
      `INSERT INTO voucher_headers
         (voucher_number, user_code, customer_number, in_date, trans_kind, is_posted, total, net_total)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8)`,
      [opts.number, opts.userCode, opts.customerNumber, opts.date,
       opts.kind ?? 'SALE', opts.posted ?? true, opts.total ?? opts.net, opts.net],
    );
  }

  /** A mirrored ERP invoice. Money in FILS, as the sync stores it. */
  async function makeErpInvoice(opts: {
    id: string; repId: string | null; customerId?: string | null;
    date: string; totalFils: number; taxFils?: number; number?: string;
    origin?: string; deleted?: boolean;
  }) {
    await q(
      `INSERT INTO erp_invoices
         (erp_id, invoice_number, issued_at, customer_id, rep_id, status, origin,
          total_fils, tax_fils, paid_fils, deleted_at)
       VALUES ($1, $2, $3::date, $4, $5, 'issued', $6, $7, $8, 0, $9)`,
      [opts.id, opts.number ?? opts.id, opts.date, opts.customerId ?? null, opts.repId,
       opts.origin ?? 'ERP', opts.totalFils, opts.taxFils ?? 0,
       opts.deleted ? new Date() : null],
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
    targets = new TargetsService(ds, null as never);

    // 'SALE' is seeded by the app, not by a migration.
    await q(`INSERT INTO transaction_kinds (trans_kind, trans_name) VALUES ('SALE', 'Sale') ON CONFLICT DO NOTHING`);

    await purge();

    const sami = await makeRep(`${P}-SAMI`, 'Sami');
    const laila = await makeRep(`${P}-LAILA`, 'Laila');
    const quiet = await makeRep(`${P}-QUIET`, 'Quiet');
    samiRepId = sami.repId;
    lailaRepId = laila.repId;
    quietRepId = quiet.repId;

    samiCustomerId = await makeCustomer(`${P}-C1`, samiRepId);
    const lailaCustomer = await makeCustomer(`${P}-C2`, lailaRepId);

    // Sami: two van sales in range.
    await makeVoucher({ number: `${P}-V1`, userCode: sami.userCode, customerNumber: `${P}-C1`,
      date: '2026-03-05', net: 100, total: 116 });
    await makeVoucher({ number: `${P}-V2`, userCode: sami.userCode, customerNumber: `${P}-C1`,
      date: '2026-03-06', net: 50, total: 58 });
    // …and one the office invoiced for his customer.
    await makeErpInvoice({ id: `${P}-E1`, repId: samiRepId, customerId: samiCustomerId,
      date: '2026-03-07', totalFils: 70_000, taxFils: 10_000 });

    // Laila: ERP only. She would have shown zero before this report existed.
    await makeErpInvoice({ id: `${P}-E2`, repId: lailaRepId, customerId: lailaCustomer,
      date: '2026-03-08', totalFils: 30_000 });

    // OUT OF SCOPE, every one of them.
    await makeVoucher({ number: `${P}-V-EARLY`, userCode: sami.userCode, customerNumber: `${P}-C1`,
      date: '2026-02-28', net: 9_999 });
    await makeVoucher({ number: `${P}-V-LATE`, userCode: sami.userCode, customerNumber: `${P}-C1`,
      date: '2026-04-01', net: 9_999 });
    await makeVoucher({ number: `${P}-V-UNPOSTED`, userCode: sami.userCode, customerNumber: `${P}-C1`,
      date: '2026-03-10', net: 9_999, posted: false });
    await makeVoucher({ number: `${P}-V-RETURN`, userCode: sami.userCode, customerNumber: `${P}-C1`,
      date: '2026-03-10', net: 9_999, kind: 'OUT' });
    await makeErpInvoice({ id: `${P}-E-EARLY`, repId: samiRepId, date: '2026-02-28', totalFils: 9_999_000 });
    await makeErpInvoice({ id: `${P}-E-LATE`, repId: samiRepId, date: '2026-04-01', totalFils: 9_999_000 });
    await makeErpInvoice({ id: `${P}-E-DELETED`, repId: samiRepId, date: '2026-03-10',
      totalFils: 9_999_000, deleted: true });
    await makeErpInvoice({ id: `${P}-E-NOREP`, repId: null, date: '2026-03-10', totalFils: 9_999_000 });
  }, 120_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  const forRep = <T extends { repId: string }>(rows: T[], id: string) =>
    rows.find((r) => r.repId === id)!;

  // ── The report ─────────────────────────────────────────────────────────────

  it('reports what each salesman sold from the van', async () => {
    const rows = await reports.salesmanSales(FROM, TO);
    const sami = forRep(rows, samiRepId);
    expect(sami.vanTotalFils).toBe(174_000);
    expect(sami.vanVouchers).toBe(2);
    expect(sami.totalFils).toBe(174_000);
  });

  it('leaves out invoices the office raised in the ERP', async () => {
    const rows = await reports.salesmanSales(FROM, TO);
    expect(forRep(rows, samiRepId).erpTotalFils).toBe(0);
    expect(forRep(rows, samiRepId).erpInvoices).toBe(0);
    const laila = forRep(rows, lailaRepId);
    expect(laila.totalFils).toBe(0);
  });

  it('lists a salesman who sold nothing rather than omitting them', async () => {
    const rows = await reports.salesmanSales(FROM, TO);
    const quiet = forRep(rows, quietRepId);
    expect(quiet.totalFils).toBe(0);
  });

  it('ignores unposted vouchers, returns and other dates', async () => {
    const rows = await reports.salesmanSales(FROM, TO);
    expect(forRep(rows, samiRepId).vanTotalFils).toBe(174_000);
  });

  it('includes both boundary days', async () => {
    const rows = await reports.salesmanSales('2026-03-05', '2026-03-06');
    expect(forRep(rows, samiRepId).vanVouchers).toBe(2);
  });

  it('ranks by what was sold', async () => {
    const rows = (await reports.salesmanSales(FROM, TO))
      .filter((r) => [samiRepId, lailaRepId, quietRepId].includes(r.repId));
    expect(rows[0].repId).toBe(samiRepId);
  });

  it('shows only the salesmen a scoped user may see', async () => {
    const rows = await reports.salesmanSales(FROM, TO, [lailaRepId]);
    expect(rows.map((r) => r.repId)).toEqual([lailaRepId]);
  });

  // ── The documents behind a row ─────────────────────────────────────────────

  it('lists only van sales behind a salesman', async () => {
    const docs = await reports.salesmanDocuments(samiRepId, FROM, TO);
    expect(docs.map((d) => d.number).sort()).toEqual([`${P}-V1`, `${P}-V2`]);
    expect(docs.every((d) => d.source === 'VAN')).toBe(true);
  });

  it('adds the documents up to the row they came from', async () => {
    const rows = await reports.salesmanSales(FROM, TO);
    const docs = await reports.salesmanDocuments(samiRepId, FROM, TO);
    expect(docs.reduce((s, d) => s + d.totalFils, 0)).toBe(forRep(rows, samiRepId).vanTotalFils);
  });

  it('scopes the documents the same way the report does', async () => {
    const numbers = (await reports.salesmanDocuments(samiRepId, FROM, TO)).map((d) => d.number);
    expect(numbers).not.toContain(`${P}-V-UNPOSTED`);
    expect(numbers).not.toContain(`${P}-V-RETURN`);
    expect(numbers).not.toContain(`${P}-V-EARLY`);
  });

  it('returns nothing for a salesman with no documents', async () => {
    expect(await reports.salesmanDocuments(quietRepId, FROM, TO)).toEqual([]);
  });

  it('orders documents newest first', async () => {
    const dates = (await reports.salesmanDocuments(samiRepId, FROM, TO)).map((d) => d.docDate);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  // ── The target, which is what people are paid on ───────────────────────────

  it('measures the target on van sales only', async () => {
    const row = await targets.getForRep(samiRepId, 2026, 3);
    expect(row.actualVanAmount).toBe(174_000);
    expect(row.actualErpAmount).toBe(0);
    expect(row.actualAmount).toBe(174_000);
  });

  it('gives a rep with only office invoices nothing', async () => {
    const row = await targets.getForRep(lailaRepId, 2026, 3);
    expect(row.actualAmount).toBe(0);
  });

  it('measures progress against van sales', async () => {
    await q(
      `INSERT INTO sales_targets (rep_id, year, month, metric, target_value)
       VALUES ($1, 2026, 3, 'AMOUNT', 348000)`,
      [samiRepId],
    );
    try {
      const row = await targets.getForRep(samiRepId, 2026, 3);
      expect(row.progressPct).toBe(50);
      expect(row.remaining).toBe(174_000);
    } finally {
      await q(`DELETE FROM sales_targets WHERE rep_id = $1`, [samiRepId]);
    }
  });
});
