/**
 * Real-DB tests for salesman targets and commission.
 *
 * A salesman here is paid on WHAT THEY SOLD and on WHAT THEY COLLECTED, at
 * different rates: a typical arrangement is 3% on a cash sale, 1.5% on a credit
 * sale, and a further 1.5% when that credit is finally collected. People are
 * paid on these numbers, so the behaviours pinned here are the ones that would
 * either short a salesman or quietly overpay them:
 *
 *  - cash and credit are told apart by the PAYMENTS, not the voucher, so a
 *    half-paid sale is not rewarded entirely at the cash rate;
 *  - an office invoice earns its rate too, and one with no payment type counts
 *    as credit — the lower rate — because guessing in the salesman's favour is
 *    how commission gets overpaid without anyone noticing;
 *  - only CONFIRMED collections count: commission on a cheque that may bounce is
 *    money paid out for money not received;
 *  - the rates come from the MONTH'S row, so changing a rate today cannot
 *    re-price a month that has already been paid;
 *  - the three components add up to the total printed beside them.
 *
 * Skipped unless DB_NAME points at a database with the schema applied.
 */
import { DataSource } from 'typeorm';

import { TargetsService } from './targets.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

const P = 'ZZCT';
const YEAR = 2026;
const MONTH = 3;

run('commission targets (real DB)', () => {
  let ds: DataSource;
  let targets: TargetsService;
  let repId = '';
  let userCode = '';
  let customerNumber = '';

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    await q(`DELETE FROM erp_invoices WHERE erp_id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM collections WHERE id IN (SELECT c.id FROM collections c JOIN reps r ON r.id=c.rep_id WHERE r.code LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM payments WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM voucher_transactions WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM voucher_headers WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM sales_targets WHERE rep_id IN (SELECT id FROM reps WHERE code LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
  }

  /** A posted SALE with its payment split. Amounts are MAJOR units, as stored. */
  async function sale(number: string, date: string, parts: { type: string; amount: number }[]) {
    const total = parts.reduce((s, p) => s + p.amount, 0);
    await q(
      `INSERT INTO voucher_headers (voucher_number, user_code, customer_number, in_date, trans_kind, is_posted, total, net_total)
       VALUES ($1,$2,$3,$4::date,'SALE',true,$5,$5)`,
      [number, userCode, customerNumber, date, total],
    );
    for (const p of parts) {
      await q(
        `INSERT INTO payments (voucher_number, payment_date, payment_type, amount) VALUES ($1,$2::date,$3,$4)`,
        [number, date, p.type, p.amount],
      );
    }
  }

  /** A confirmed collection, in MAJOR units. */
  async function collection(date: string, amount: number, status = 'confirmed') {
    await q(
      `INSERT INTO collections (customer_id, rep_id, amount, method, status, collected_at)
       VALUES ((SELECT id FROM customers WHERE customer_number=$1), $2, $3, 'cash', $4, $5::date)`,
      [customerNumber, repId, amount, status, date],
    );
  }

  /** A mirrored ERP invoice, in FILS. */
  async function erpInvoice(id: string, date: string, totalFils: number, paymentType: string | null) {
    await q(
      `INSERT INTO erp_invoices (erp_id, invoice_number, issued_at, rep_id, status, origin, total_fils, tax_fils, paid_fils, payment_type)
       VALUES ($1,$1,$2::date,$3,'issued','ERP',$4,0,0,$5)`,
      [id, date, repId, totalFils, paymentType],
    );
  }

  async function setTarget(fields: Record<string, unknown>) {
    await q(`DELETE FROM sales_targets WHERE rep_id=$1 AND year=$2 AND month=$3`, [repId, YEAR, MONTH]);
    await targets.upsert({ repId, year: YEAR, month: MONTH, ...fields } as never);
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'cashvan',
      database: process.env.DB_NAME as string,
      entities: [__dirname + '/../../**/*.entity.{ts,js}'],
      synchronize: false,
    });
    await ds.initialize();
    targets = new TargetsService(ds, ds.getRepository('SalesTarget') as never);

    await q(`INSERT INTO transaction_kinds (trans_kind, trans_name) VALUES ('SALE','Sale') ON CONFLICT DO NOTHING`);
    await purge();

    userCode = `${P}-U1`;
    const [u] = await q(
      `INSERT INTO users (user_number, name, password_hash, user_type) VALUES ($1,'ZZ Rep','x','SALES') RETURNING id`,
      [userCode],
    );
    const [r] = await q(
      `INSERT INTO reps (user_id, code, name_ar, is_active) VALUES ($1,$2,'ZZ Rep',true) RETURNING id`,
      [u.id, `${P}-R1`],
    );
    repId = r.id;
    customerNumber = `${P}-C1`;
    await q(
      `INSERT INTO customers (customer_number, customer_name, name_ar, rep_id) VALUES ($1,$1,$1,$2)`,
      [customerNumber, repId],
    );

    // 1,000 fully cash. 2,000 fully on account. 1,000 half and half.
    await sale(`${P}-V1`, '2026-03-05', [{ type: 'CASH', amount: 1000 }]);
    await sale(`${P}-V2`, '2026-03-06', [{ type: 'CREDIT', amount: 2000 }]);
    await sale(`${P}-V3`, '2026-03-07', [
      { type: 'CASH', amount: 500 },
      { type: 'CREDIT', amount: 500 },
    ]);

    // Collections: 800 confirmed, 400 pending (must not count).
    await collection('2026-03-10', 800);
    await collection('2026-03-11', 400, 'pending');
    // Bounced money came back — it must not earn commission either.
    await collection('2026-03-15', 300, 'bounced');

    // Office invoices: 600 cash, 400 credit, 200 with no type stated.
    await erpInvoice(`${P}-E1`, '2026-03-12', 600_000, 'CASH');
    await erpInvoice(`${P}-E2`, '2026-03-13', 400_000, 'CREDIT');
    await erpInvoice(`${P}-E3`, '2026-03-14', 200_000, null);
  }, 120_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  // ── Splitting cash from credit ─────────────────────────────────────────────

  it('splits van sales on the payments, not on the voucher', async () => {
    await setTarget({ cashPct: 3, creditPct: 1.5, collectionPct: 1.5 });
    const row = await targets.getForRep(repId, YEAR, MONTH);
    // Van cash 1,000 + 500 = 1,500, plus the ERP's 600 cash → 2,100.
    expect(row.cashSalesFils).toBe(2_100_000);
    // Van credit 2,000 + 500 = 2,500, plus ERP 400 + the untyped 200 → 3,100.
    expect(row.creditSalesFils).toBe(3_100_000);
    expect(row.totalSalesFils).toBe(5_200_000);
  });

  it('counts an office invoice with no payment type as credit, the lower rate', async () => {
    // Guessing in the salesman's favour is how commission gets overpaid quietly.
    await setTarget({ cashPct: 3, creditPct: 1.5, collectionPct: 0 });
    const row = await targets.getForRep(repId, YEAR, MONTH);
    const withUntyped = row.creditSalesFils;
    await q(`UPDATE erp_invoices SET payment_type='CASH' WHERE erp_id=$1`, [`${P}-E3`]);
    try {
      const after = await targets.getForRep(repId, YEAR, MONTH);
      expect(withUntyped - after.creditSalesFils).toBe(200_000);
      expect(after.cashSalesFils - row.cashSalesFils).toBe(200_000);
    } finally {
      await q(`UPDATE erp_invoices SET payment_type=NULL WHERE erp_id=$1`, [`${P}-E3`]);
    }
  });

  it('counts collected money only — not pending, not bounced', async () => {
    // Commission on a cheque that may bounce is money paid for money not
    // received; on one that already bounced it is money paid for money returned.
    // The vocabulary is lowercase, and comparing against 'CONFIRMED' matches
    // nothing — which reads as a salesman who collected zero.
    await setTarget({ collectionPct: 1.5 });
    const row = await targets.getForRep(repId, YEAR, MONTH);
    expect(row.collectedFils).toBe(800_000);
  });

  // ── The money ──────────────────────────────────────────────────────────────

  it('pays each component at its own rate', async () => {
    await setTarget({ cashPct: 3, creditPct: 1.5, collectionPct: 1.5 });
    const row = await targets.getForRep(repId, YEAR, MONTH);
    expect(row.commissionOnCashFils).toBe(Math.round(2_100_000 * 0.03));       // 63,000
    expect(row.commissionOnCreditFils).toBe(Math.round(3_100_000 * 0.015));    // 46,500
    expect(row.commissionOnCollectionFils).toBe(Math.round(800_000 * 0.015));  // 12,000
  });

  it('adds the components up to the total printed beside them', async () => {
    await setTarget({ cashPct: 3, creditPct: 1.5, collectionPct: 1.5 });
    const r = await targets.getForRep(repId, YEAR, MONTH);
    expect(r.commissionTotalFils).toBe(
      r.commissionOnCashFils + r.commissionOnCreditFils + r.commissionOnCollectionFils,
    );
    expect(r.commissionTotalFils).toBe(121_500);
  });

  it('pays nothing when no rate is set', async () => {
    await setTarget({});
    const row = await targets.getForRep(repId, YEAR, MONTH);
    expect(row.commissionTotalFils).toBe(0);
    // …but still reports what was sold, so the figures are visible before the
    // rates are agreed.
    expect(row.totalSalesFils).toBe(5_200_000);
  });

  // ── Targets: optional, independent ─────────────────────────────────────────

  it('measures each target against its own achievement', async () => {
    await setTarget({ salesTargetFils: 10_400_000, collectionTargetFils: 1_600_000 });
    const row = await targets.getForRep(repId, YEAR, MONTH);
    expect(row.salesProgressPct).toBe(50);
    expect(row.collectionProgressPct).toBe(50);
  });

  it('allows a collection target with no sales target', async () => {
    await setTarget({ collectionTargetFils: 800_000 });
    const row = await targets.getForRep(repId, YEAR, MONTH);
    expect(row.salesTargetFils).toBeNull();
    expect(row.salesProgressPct).toBeNull();
    expect(row.collectionProgressPct).toBe(100);
  });

  it('allows rates with no target at all', async () => {
    // Paying commission without setting targets is normal; neither implies the other.
    await setTarget({ cashPct: 3 });
    const row = await targets.getForRep(repId, YEAR, MONTH);
    expect(row.salesTargetFils).toBeNull();
    expect(row.collectionTargetFils).toBeNull();
    expect(row.commissionOnCashFils).toBeGreaterThan(0);
  });

  it('treats a zero target as unset, not as already achieved', async () => {
    // Dividing by it would report a triumphant 100% for someone who sold nothing.
    await setTarget({ salesTargetFils: 0 });
    const row = await targets.getForRep(repId, YEAR, MONTH);
    expect(row.salesProgressPct).toBeNull();
  });

  // ── Editing must not destroy what it did not mention ───────────────────────

  it('does not clear a target when only a rate is edited', async () => {
    await setTarget({ salesTargetFils: 5_000_000, collectionTargetFils: 900_000, cashPct: 3 });
    await targets.upsert({ repId, year: YEAR, month: MONTH, cashPct: 4 } as never);
    const row = await targets.getForRep(repId, YEAR, MONTH);
    expect(row.cashPct).toBe(4);
    expect(row.salesTargetFils).toBe(5_000_000);
    expect(row.collectionTargetFils).toBe(900_000);
  });

  it('clears a target when it is explicitly set to null', async () => {
    // null is a real instruction and must be told apart from "not mentioned".
    await setTarget({ salesTargetFils: 5_000_000 });
    await targets.upsert({ repId, year: YEAR, month: MONTH, salesTargetFils: null } as never);
    const row = await targets.getForRep(repId, YEAR, MONTH);
    expect(row.salesTargetFils).toBeNull();
  });

  it('keeps each month on its own rates', async () => {
    // A rate agreed in March must not re-price February.
    await setTarget({ cashPct: 3 });
    await targets.upsert({ repId, year: YEAR, month: 2, cashPct: 10 } as never);
    try {
      const mar = await targets.getForRep(repId, YEAR, MONTH);
      const feb = await targets.getForRep(repId, YEAR, 2);
      expect(mar.cashPct).toBe(3);
      expect(feb.cashPct).toBe(10);
      // February has no sales, so a higher rate still earns nothing.
      expect(feb.commissionTotalFils).toBe(0);
    } finally {
      await q(`DELETE FROM sales_targets WHERE rep_id=$1 AND month=2`, [repId]);
    }
  });

  it('appears in the list for the month as well as the single lookup', async () => {
    await setTarget({ cashPct: 3, creditPct: 1.5, collectionPct: 1.5, salesTargetFils: 10_400_000 });
    const rows = await targets.list(YEAR, MONTH);
    const mine = rows.find((r) => r.repId === repId)!;
    const one = await targets.getForRep(repId, YEAR, MONTH);
    expect(mine.commissionTotalFils).toBe(one.commissionTotalFils);
    expect(mine.salesProgressPct).toBe(one.salesProgressPct);
  });
});
