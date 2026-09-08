/**
 * Real-DB tests for "customers by salesman".
 *
 * The report answers two questions: who carries how much of the book, and who
 * carries customers nobody can serve. The second is the one that costs money —
 * the salesman report and the commission target both key on rep_id, so a
 * customer in either unserved bucket contributes to nobody's figures.
 *
 * Skipped unless DB_NAME points at a database with the schema applied.
 */
import { DataSource } from 'typeorm';

import { ReportsService } from './reports.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

const P = 'ZZCBR';

run('customers by salesman (real DB)', () => {
  let ds: DataSource;
  let reports: ReportsService;
  let samiId = '';
  let lailaId = '';
  let deletedRepId = '';

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
  }

  async function makeRep(code: string, name: string, active = true) {
    const [u] = await q(
      `INSERT INTO users (user_number, name, password_hash, user_type) VALUES ($1,$2,'x','SALES') RETURNING id`,
      [code, name],
    );
    const [r] = await q(
      `INSERT INTO reps (user_id, code, name_ar, is_active) VALUES ($1,$2,$3,$4) RETURNING id`,
      [u.id, code, name, active],
    );
    return r.id as string;
  }

  async function makeCustomer(n: string, repId: string | null, opts: { active?: boolean; debt?: number } = {}) {
    await q(
      `INSERT INTO customers (customer_number, customer_name, name_ar, rep_id, is_active, total_debt)
       VALUES ($1,$1,$1,$2,$3,$4)`,
      [n, repId, opts.active ?? true, opts.debt ?? 0],
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
    samiId = await makeRep(`${P}-SAMI`, 'Sami');
    lailaId = await makeRep(`${P}-LAILA`, 'Laila');
    deletedRepId = await makeRep(`${P}-GONE`, 'Gone');

    await makeCustomer(`${P}-C1`, samiId, { debt: 1000 });
    await makeCustomer(`${P}-C2`, samiId, { debt: 500 });
    await makeCustomer(`${P}-C3`, samiId, { active: false, debt: 250 });
    await makeCustomer(`${P}-C4`, lailaId);
    await makeCustomer(`${P}-C5`, null, { debt: 700 });        // nobody
    await makeCustomer(`${P}-C6`, deletedRepId, { debt: 300 }); // a rep about to vanish
    await makeCustomer(`${P}-C7`, samiId);
    await q(`UPDATE customers SET deleted_at = now() WHERE customer_number = $1`, [`${P}-C7`]);

    // Delete the salesman but leave their customer pointing at them — the exact
    // situation this report exists to surface.
    await q(`UPDATE reps SET deleted_at = now() WHERE id = $1`, [deletedRepId]);
  }, 120_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  const mine = async () => (await reports.customersByRep()).filter((r) => r.repCode?.startsWith(P));

  it('counts each salesman’s customers', async () => {
    const rows = await mine();
    const sami = rows.find((r) => r.repId === samiId)!;
    expect(sami.customers).toBe(3);        // C1, C2, C3 — C7 is deleted
    expect(sami.activeCustomers).toBe(2);  // C3 is inactive
    expect(sami.totalDebtFils).toBe(1750);
  });

  it('lists a salesman with no customers rather than omitting them', async () => {
    // A salesman carrying nobody is exactly what this report should surface.
    const rows = await mine();
    const laila = rows.find((r) => r.repId === lailaId)!;
    expect(laila.customers).toBe(1);
    const empty = await makeRep(`${P}-EMPTY`, 'Empty');
    try {
      const again = await mine();
      expect(again.find((r) => r.repId === empty)?.customers).toBe(0);
    } finally {
      await q(`DELETE FROM reps WHERE id = $1`, [empty]);
      await q(`DELETE FROM users WHERE user_number = $1`, [`${P}-EMPTY`]);
    }
  });

  it('excludes a deleted salesman from the list', async () => {
    const rows = await mine();
    expect(rows.some((r) => r.repId === deletedRepId)).toBe(false);
  });

  it('counts a deleted customer for nobody', async () => {
    const rows = await mine();
    const sami = rows.find((r) => r.repId === samiId)!;
    expect(sami.customers).toBe(3);
  });

  // ── The buckets that cost money ────────────────────────────────────────────

  it('separates "no salesman" from "salesman was deleted"', async () => {
    // Both are unserved, but they are different mistakes with different fixes.
    // Rolled together they look like one problem and get one wrong fix.
    const u = await reports.unassignedCustomerCounts();
    expect(u.noRep).toBeGreaterThanOrEqual(1);
    expect(u.orphanedRep).toBeGreaterThanOrEqual(1);
  });

  it('reports what the unserved customers owe', async () => {
    const u = await reports.unassignedCustomerCounts();
    expect(u.noRepDebtFils).toBeGreaterThanOrEqual(700);
    expect(u.orphanedDebtFils).toBeGreaterThanOrEqual(300);
  });

  // ── Drill-down ─────────────────────────────────────────────────────────────

  it('lists the customers behind a salesman', async () => {
    const rows = await reports.customersForRep(samiId);
    expect(rows.map((r) => r.customerNumber).sort()).toEqual([`${P}-C1`, `${P}-C2`, `${P}-C3`]);
    expect(rows.find((r) => r.customerNumber === `${P}-C1`)!.debtFils).toBe(1000);
  });

  it('lists the customers with no salesman', async () => {
    const rows = await reports.customersForRep('none');
    expect(rows.some((r) => r.customerNumber === `${P}-C5`)).toBe(true);
    expect(rows.some((r) => r.customerNumber === `${P}-C1`)).toBe(false);
  });

  it('lists the customers whose salesman was deleted', async () => {
    const rows = await reports.customersForRep('orphaned');
    expect(rows.some((r) => r.customerNumber === `${P}-C6`)).toBe(true);
    // Not the same set as "no salesman" — that is the whole point of two buckets.
    expect(rows.some((r) => r.customerNumber === `${P}-C5`)).toBe(false);
  });

  it('adds the drill-down up to the count beside it', async () => {
    const rows = await mine();
    const sami = rows.find((r) => r.repId === samiId)!;
    const detail = await reports.customersForRep(samiId);
    expect(detail).toHaveLength(sami.customers);
  });

  it('shows only the salesmen a scoped user may see', async () => {
    const rows = await reports.customersByRep([lailaId]);
    expect(rows.map((r) => r.repId)).toEqual([lailaId]);
  });
});
