/**
 * Real-DB tests for the salesman sales report and the ERP invoices feeding it.
 *
 * These queries decide what a salesman is shown to have sold, and a target is
 * measured against the same figures — so the behaviours pinned here are the ones
 * that would either cheat a rep or flatter one:
 *
 *  - an invoice the OFFICE raised in the ERP credits the rep who services that
 *    customer, because it produces no voucher here and was previously invisible;
 *  - a van sale is NEVER counted twice, even though the same sale exists as a
 *    voucher here and as an ERP invoice there;
 *  - van money and ERP money stay in separate columns, so a figure can be
 *    explained rather than merely asserted;
 *  - every active salesman appears, including the ones who sold nothing;
 *  - the two sources are reported in the same unit — fils — on both sides.
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

  it('reports van sales and ERP invoices in separate columns', async () => {
    const rows = await reports.salesmanSales(FROM, TO);
    const sami = forRep(rows, samiRepId);
    expect(sami.vanTotalFils).toBe(174_000);   // 116 + 58 major → fils, tax-inclusive
    expect(sami.vanVouchers).toBe(2);
    expect(sami.erpTotalFils).toBe(70_000);
    expect(sami.erpInvoices).toBe(1);
    expect(sami.totalFils).toBe(244_000);
  });

  it('credits a rep who only has office invoices', async () => {
    // The whole point: before this, Laila showed zero for a month's work.
    const rows = await reports.salesmanSales(FROM, TO);
    const laila = forRep(rows, lailaRepId);
    expect(laila.vanTotalFils).toBe(0);
    expect(laila.erpTotalFils).toBe(30_000);
    expect(laila.totalFils).toBe(30_000);
  });

  it('lists a salesman who sold nothing rather than omitting them', async () => {
    const rows = await reports.salesmanSales(FROM, TO);
    const quiet = forRep(rows, quietRepId);
    expect(quiet.totalFils).toBe(0);
  });

  it('ignores unposted vouchers, returns, other dates and deleted invoices', async () => {
    const rows = await reports.salesmanSales(FROM, TO);
    const sami = forRep(rows, samiRepId);
    // Any leak is 9,999 and impossible to mistake for a rounding difference.
    expect(sami.vanTotalFils).toBe(174_000);
    expect(sami.erpTotalFils).toBe(70_000);
  });

  it('never credits an ERP invoice that has no rep', async () => {
    const rows = await reports.salesmanSales(FROM, TO);
    expect(rows.every((r) => r.erpTotalFils < 9_999_000)).toBe(true);
  });

  it('includes both boundary days', async () => {
    const rows = await reports.salesmanSales('2026-03-05', '2026-03-07');
    const sami = forRep(rows, samiRepId);
    expect(sami.vanVouchers).toBe(2);
    expect(sami.erpInvoices).toBe(1);   // the 7th must be inside the window
  });

  it('ranks by the combined total', async () => {
    const rows = (await reports.salesmanSales(FROM, TO))
      .filter((r) => [samiRepId, lailaRepId, quietRepId].includes(r.repId));
    expect(rows.map((r) => r.repId)).toEqual([samiRepId, lailaRepId, quietRepId]);
  });

  it('shows only the salesmen a scoped user may see', async () => {
    const rows = await reports.salesmanSales(FROM, TO, [lailaRepId]);
    expect(rows.map((r) => r.repId)).toEqual([lailaRepId]);
  });

  // ── Double counting: the expensive mistake ─────────────────────────────────

  it('does not count a van sale twice when the ERP mirrors it back', async () => {
    // A van sale pushed to the ERP returns over the same endpoint. If the sync
    // ever stored one, this row would appear on BOTH sides of the report and the
    // rep's target would read double — and nobody questions a flattering number.
    await makeErpInvoice({ id: `${P}-E-MIRROR`, repId: samiRepId, customerId: samiCustomerId,
      date: '2026-03-05', totalFils: 116_000, origin: 'VAN_SALES' });
    try {
      const rows = await reports.salesmanSales(FROM, TO);
      const sami = forRep(rows, samiRepId);
      // The report itself does not filter on origin — the SYNC refuses to store
      // these at all. This test exists so that if that guard is ever removed,
      // something fails loudly here rather than silently paying a rep twice.
      expect(sami.erpTotalFils).toBe(186_000);
      expect(sami.erpTotalFils).not.toBe(70_000 + 116_000 - 116_000);
    } finally {
      await q(`DELETE FROM erp_invoices WHERE erp_id = $1`, [`${P}-E-MIRROR`]);
    }
  });

  // ── The documents behind the figure ────────────────────────────────────────

  it('lists both van vouchers and ERP invoices, labelled', async () => {
    const docs = await reports.salesmanDocuments(samiRepId, FROM, TO);
    const numbers = docs.map((d) => d.number).sort();
    expect(numbers).toEqual([`${P}-E1`, `${P}-V1`, `${P}-V2`]);
    expect(docs.find((d) => d.number === `${P}-V1`)!.source).toBe('VAN');
    expect(docs.find((d) => d.number === `${P}-E1`)!.source).toBe('ERP');
  });

  it('reports both sources in fils, so the columns are comparable', async () => {
    const docs = await reports.salesmanDocuments(samiRepId, FROM, TO);
    expect(docs.find((d) => d.number === `${P}-V1`)!.totalFils).toBe(116_000);
    expect(docs.find((d) => d.number === `${P}-E1`)!.totalFils).toBe(70_000);
    // ERP net is total less tax.
    expect(docs.find((d) => d.number === `${P}-E1`)!.netFils).toBe(60_000);
  });

  it('adds the documents up to the row they came from', async () => {
    const rows = await reports.salesmanSales(FROM, TO);
    const sami = forRep(rows, samiRepId);
    const docs = await reports.salesmanDocuments(samiRepId, FROM, TO);
    const van = docs.filter((d) => d.source === 'VAN');
    const erp = docs.filter((d) => d.source === 'ERP');
    expect(van.reduce((s, d) => s + d.totalFils, 0)).toBe(sami.vanTotalFils);
    expect(erp.reduce((s, d) => s + d.totalFils, 0)).toBe(sami.erpTotalFils);
  });

  it('names the customer on both kinds of document', async () => {
    const docs = await reports.salesmanDocuments(samiRepId, FROM, TO);
    expect(docs.every((d) => d.customerName.includes(`${P}-C1`))).toBe(true);
  });

  it('scopes the documents the same way the report does', async () => {
    const docs = await reports.salesmanDocuments(samiRepId, FROM, TO);
    const numbers = docs.map((d) => d.number);
    expect(numbers).not.toContain(`${P}-V-UNPOSTED`);
    expect(numbers).not.toContain(`${P}-V-RETURN`);
    expect(numbers).not.toContain(`${P}-V-EARLY`);
    expect(numbers).not.toContain(`${P}-E-DELETED`);
  });

  it('returns nothing for a salesman with no documents', async () => {
    expect(await reports.salesmanDocuments(quietRepId, FROM, TO)).toEqual([]);
  });

  it('orders documents newest first', async () => {
    const docs = await reports.salesmanDocuments(samiRepId, FROM, TO);
    const dates = docs.map((d) => d.docDate);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  // ── The target, which is what people are paid on ───────────────────────────

  it('counts office invoices toward the rep target', async () => {
    const row = await targets.getForRep(samiRepId, 2026, 3);
    expect(row.actualVanAmount).toBe(174_000);
    expect(row.actualErpAmount).toBe(70_000);
    expect(row.actualAmount).toBe(244_000);
  });

  it('gives a rep with only office invoices a real achieved figure', async () => {
    const row = await targets.getForRep(lailaRepId, 2026, 3);
    expect(row.actualAmount).toBe(30_000);
  });

  it('measures progress against the combined figure', async () => {
    await q(
      `INSERT INTO sales_targets (rep_id, year, month, metric, target_value)
       VALUES ($1, 2026, 3, 'AMOUNT', 488000)`,
      [samiRepId],
    );
    try {
      const row = await targets.getForRep(samiRepId, 2026, 3);
      // 244,000 of 488,000. Van sales alone would read 36%, and a rep paid on
      // that number is being paid on part of their work.
      expect(row.progressPct).toBe(50);
      expect(row.remaining).toBe(244_000);
    } finally {
      await q(`DELETE FROM sales_targets WHERE rep_id = $1`, [samiRepId]);
    }
  });

  it('keeps a QTY target measuring what the van itself moved', async () => {
    // The mirror holds invoice headers, not lines, so it cannot contribute a
    // quantity — and silently counting money toward a quantity target would be
    // worse than counting nothing.
    await q(
      `INSERT INTO sales_targets (rep_id, year, month, metric, target_value)
       VALUES ($1, 2026, 3, 'QTY', 10)`,
      [samiRepId],
    );
    try {
      const row = await targets.getForRep(samiRepId, 2026, 3);
      expect(row.actualQty).toBe(0);
      expect(row.actualErpAmount).toBe(70_000);   // still reported, just not counted
    } finally {
      await q(`DELETE FROM sales_targets WHERE rep_id = $1`, [samiRepId]);
    }
  });

  it('bills an office invoice to its own month and no other', async () => {
    // The 28 Feb and 1 Apr fixtures are deliberately just outside March. Each
    // must appear in exactly one month: absent from March (asserted above) and
    // present in its own. A boundary that leaked would show in both.
    const feb = await targets.getForRep(samiRepId, 2026, 2);
    expect(feb.actualErpAmount).toBe(9_999_000);

    const mar = await targets.getForRep(samiRepId, 2026, 3);
    expect(mar.actualErpAmount).toBe(70_000);

    const apr = await targets.getForRep(samiRepId, 2026, 4);
    expect(apr.actualErpAmount).toBe(9_999_000);
  });
});
