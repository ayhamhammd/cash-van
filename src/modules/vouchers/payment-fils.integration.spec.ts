/**
 * Real DB, real services: payments keep their third decimal (fils).
 *
 *  - a 1.584 cash sale through the phone's intake (sync/vouchers → the vouchers
 *    path) stores a 1.584 payment, and the rep's cash box gets 1584 fils;
 *  - an ORDER's default CREDIT row carries the exact net total;
 *  - the repair touches only a single payment equal to ROUND(net, 2), counts
 *    the rest, and a dry run writes nothing;
 *  - the migration narrows and widens back.
 *
 * Boots the whole AppModule against the test database. Skipped unless DB_NAME
 * points at a database with the schema applied. Creates and removes everything
 * under ZZFIL.
 */
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { PaymentMoney3dp1728720000000 } from '../../database/migrations/1728720000000-PaymentMoney3dp';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;
const P = 'ZZFIL';

jest.setTimeout(300_000);

run('payments keep their fils (real DB, real intake)', () => {
  let app: INestApplicationContext;
  // Loaded after AppModule (see beforeAll): importing the vouchers service
  // first resolves its import cycle with erp-sync in the wrong order.
  let SyncService: typeof import('../sync/sync.service').SyncService;
  let VouchersService: typeof import('./vouchers.service').VouchersService;
  let PaymentFilsRepairService: typeof import('./payment-fils-repair.service').PaymentFilsRepairService;
  let ds: DataSource;
  let repId = '';
  let userId = '';
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params);

  async function purge() {
    await q(`DELETE FROM account_transactions WHERE ref_id LIKE $1 OR ref_id IN (SELECT voucher_number FROM voucher_headers WHERE user_code = $2)`, [
      `${P}%`,
      `${P}R`,
    ]);
    await q(`DELETE FROM cash_accounts WHERE rep_id IN (SELECT id FROM reps WHERE code LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM erp_outbox WHERE ref IN (SELECT voucher_number FROM voucher_headers WHERE user_code = $1)`, [`${P}R`]);
    await q(`DELETE FROM customer_visits WHERE customer_id IN (SELECT id FROM customers WHERE customer_number LIKE $1)`, [`${P}%`]).catch(() => undefined);
    await q(`DELETE FROM voucher_inbox WHERE client_ref LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM voucher_headers WHERE user_code = $1 OR voucher_number LIKE $2`, [`${P}R`, `${P}%`]);
    await q(`DELETE FROM van_stock WHERE rep_id IN (SELECT id FROM reps WHERE code LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM stock_movements WHERE store_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM stock_balance WHERE store_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM item_cart WHERE item_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM warehouses WHERE wh_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
  }

  beforeAll(async () => {
    // Loaded here: importing the whole graph where this suite is skipped crashes the worker.
    const { AppModule } = await import('../../app.module');
    ({ SyncService } = await import('../sync/sync.service'));
    ({ VouchersService } = await import('./vouchers.service'));
    ({ PaymentFilsRepairService } = await import('./payment-fils-repair.service'));
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = await mod.init();
    ds = app.get(DataSource);
    await purge();

    [{ id: userId }] = await q<{ id: string }>(
      `INSERT INTO users (user_number, name, password_hash, user_type, role, is_active, can_create_sale, can_make_voucher)
       VALUES ($1, 'Rep', 'x', 'SALES', 'viewer', true, true, true) RETURNING id`,
      [`${P}R`],
    );
    const [{ id: wh }] = await q<{ id: string }>(
      `INSERT INTO warehouses (wh_number, wh_name, is_van) VALUES ($1, $1, true) RETURNING id`,
      [`${P}R`],
    );
    [{ id: repId }] = await q<{ id: string }>(
      `INSERT INTO reps (code, name_ar, user_id, van_id) VALUES ($1, 'مندوب', $2, $3) RETURNING id`,
      [`${P}R`, userId, wh],
    );
    await q(`INSERT INTO customers (customer_number, customer_name, name_ar) VALUES ($1, 'Shop', 'زبون')`, [`${P}C`]);
    const [{ id: item }] = await q<{ id: string }>(
      `INSERT INTO item_cart (item_number, item_name, barcode, sku, name_ar, price, tax_percentage, tax_rate, tax_type)
       VALUES ($1, 'Thing', $1, $1, 'شيء', 1584, 0, 0, 'EXEMPT') RETURNING id`,
      [`${P}I`],
    );
    // Stock on the van, in the van ledger and the store ledger.
    await q(`INSERT INTO van_stock (rep_id, product_id, stock_unit_code, quantity, reserved) VALUES ($1, $2, '', 10, 0)`, [repId, item]);
    await q(
      `INSERT INTO stock_balance (store_number, item_number, stock_unit_code, qty_milli, last_seq) VALUES ($1, $2, '', 10000, 0)
       ON CONFLICT DO NOTHING`,
      [`${P}R`, `${P}I`],
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await app.close();
  });

  it('a 1.584 cash sale through the phone intake: payment 1.584, cash box +1584 fils', async () => {
    const sync = app.get(SyncService);
    const out = await sync.ingestVoucher(
      {
        clientRef: `${P}-sale-1`,
        transKind: 'SALE',
        userCode: `${P}R`,
        customerNumber: `${P}C`,
        transactions: [{ itemNumber: `${P}I`, itemName: 'Thing', itemQty: '1', unitPrice: '1.584' }],
        payments: [{ amount: '1.584', paymentType: 'CASH' }],
      } as never,
      { sub: userId, repId, userNumber: `${P}R`, userType: 'SALES', role: 'viewer', permissions: { canCreateSale: true }, permKeys: [] } as never,
    );
    expect(out.status).toBe('posted');
    const vn = out.voucherNumber;
    const [h] = await q<{ net_total: string }>(`SELECT net_total FROM voucher_headers WHERE voucher_number = $1`, [vn]);
    expect(h.net_total).toBe('1.584');
    const pays = await q<{ amount: string; payment_type: string }>(`SELECT amount, payment_type FROM payments WHERE voucher_number = $1`, [vn]);
    expect(pays).toEqual([{ amount: '1.584', payment_type: 'CASH' }]);

    // The cash box listener runs after the post; give it a moment.
    let entry: Array<{ amount_fils: string }> = [];
    for (let i = 0; i < 50 && !entry.length; i += 1) {
      entry = await q(`SELECT amount_fils FROM account_transactions WHERE ref_type = 'voucher' AND ref_id = $1`, [vn]);
      if (!entry.length) await new Promise((r) => setTimeout(r, 100));
    }
    expect(entry.map((e) => Number(e.amount_fils))).toEqual([1584]);
  });

  it("an ORDER's default CREDIT row is the exact net total", async () => {
    const order = await app.get(VouchersService).create({
      transKind: 'ORDER',
      userCode: `${P}R`,
      customerNumber: `${P}C`,
      isPosted: true,
      transactions: [{ itemNumber: `${P}I`, itemName: 'Thing', itemQty: '1', unitPrice: '1.584', storeNumber: `${P}R` }],
    } as never);
    expect(await q(`SELECT amount, payment_type FROM payments WHERE voucher_number = $1`, [order.voucherNumber])).toEqual([
      { amount: '1.584', payment_type: 'CREDIT' },
    ]);
  });

  it('the repair: only a single payment equal to ROUND(net, 2) is fixed; a dry run writes nothing', async () => {
    const mk = async (n: string, net: string, payments: string[]) => {
      await q(
        `INSERT INTO voucher_headers (voucher_number, user_code, trans_kind, customer_number, is_posted, total, net_total)
         VALUES ($1, $2, 'SALE', $3, true, $4, $4)`,
        [`${P}-${n}`, `${P}R`, `${P}C`, net],
      );
      for (const a of payments) {
        await q(`INSERT INTO payments (voucher_number, amount, payment_type) VALUES ($1, $2, 'CASH')`, [`${P}-${n}`, a]);
      }
    };
    await mk('A', '1.584', ['1.580']); // rounded by the old column → repaired
    await mk('B', '2.625', ['2.630']); // rounded up (ERP-RET-CN-…-00003's case) → repaired
    await mk('C', '1.584', ['1.584']); // already exact → untouched
    await mk('D', '1.584', ['1.000']); // a part payment → left, counted
    await mk('E', '1.584', ['1.000', '0.580']); // split → left, counted
    const amounts = async () =>
      Object.fromEntries(
        (
          await q<{ voucher_number: string; a: string }>(
            `SELECT voucher_number, string_agg(amount::text, '+' ORDER BY amount) AS a FROM payments
              WHERE voucher_number LIKE $1 GROUP BY voucher_number`,
            [`${P}-%`],
          )
        ).map((r) => [r.voucher_number.replace(`${P}-`, ''), r.a]),
      );
    const before = await amounts();

    const repair = app.get(PaymentFilsRepairService);
    const dry = await repair.repair({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.sample).toEqual(expect.arrayContaining([`${P}-A`, `${P}-B`]));
    expect(dry.sample).not.toEqual(expect.arrayContaining([`${P}-C`]));
    expect(await amounts()).toEqual(before);

    const done = await repair.repair();
    expect(done.sample).toEqual(expect.arrayContaining([`${P}-A`, `${P}-B`]));
    expect(done.leftAlone.multiPayment).toBeGreaterThanOrEqual(1);
    expect(done.leftAlone.singleNotRounding).toBeGreaterThanOrEqual(1);
    expect(await amounts()).toEqual({ ...before, A: '1.584', B: '2.625' });

    const again = await repair.repair();
    expect(again.sample.filter((v) => v.startsWith(P))).toEqual([]);
  });

  it('the migration narrows and widens back', async () => {
    const scales = async () =>
      (
        await q<{ c: string; s: number }>(
          `SELECT table_name || '.' || column_name AS c, numeric_scale AS s FROM information_schema.columns
            WHERE (table_name, column_name) IN (('payments','amount'), ('payment_cheques','amount'),
                   ('customers','total_debt'), ('item_units','sale_price'), ('warehouses','wh_debit_box'))
            ORDER BY 1`,
        )
      ).map((r) => `${r.c}:${r.s}`);
    expect(await scales()).toEqual([
      'customers.total_debt:3',
      'item_units.sale_price:3',
      'payment_cheques.amount:3',
      'payments.amount:3',
      'warehouses.wh_debit_box:3',
    ]);
    const m = new PaymentMoney3dp1728720000000();
    const qr = ds.createQueryRunner();
    await qr.connect();
    try {
      await qr.startTransaction();
      await m.down(qr);
      await qr.commitTransaction();
      expect(await scales()).toEqual([
        'customers.total_debt:2',
        'item_units.sale_price:2',
        'payment_cheques.amount:2',
        'payments.amount:2',
        'warehouses.wh_debit_box:2',
      ]);
      // Narrowing rounds the fils away — the documented price of a revert.
      expect(await q(`SELECT amount::text AS a FROM payments WHERE voucher_number = $1`, [`${P}-A`])).toEqual([{ a: '1.58' }]);
      await qr.startTransaction();
      await m.up(qr);
      await qr.commitTransaction();
      expect((await scales()).every((s) => s.endsWith(':3'))).toBe(true);
    } finally {
      await qr.release();
    }
  });
});
