/**
 * Real-DB, real services: delivery rep phase 4 — increase requests
 * (delivery phase-4 contract §B).
 *
 * Boots the whole AppModule against the test database, so "Create order" runs
 * through the REAL VouchersService and PricingService — the same path the
 * dashboard's New voucher and the phone's sync/vouchers use — and this checks
 * what that path wrote, not what a fake said it would:
 *
 *  - the intake ignores `increase` with the company switch off, stores it with
 *    the switch on, and tells the managers;
 *  - /order makes ONE ORDER voucher for the request's customer, under the
 *    customer's own salesman, priced from the customer's contract price, tax
 *    from the item, payment CREDIT, the reason in the note, and its ERP
 *    SALES_ORDER outbox row; the request is ORDERED;
 *  - the same Idempotency-Key answers the same order; another decision is 409;
 *  - dismiss needs its note and tells the rep;
 *  - the Stop carries the request on the phone and on the dashboard.
 *
 * Skipped unless DB_NAME points at a database with the schema applied. Creates
 * and removes everything under ZZINC.
 */
import { ConflictException, INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { DeliveriesService } from './deliveries.service';
import { DeliveryIncreasesService } from './delivery-increases.service';
import { DeliveryIntakeService } from './delivery-intake.service';
import { DeliveryMirrorService } from './delivery-mirror.service';
import type { ErpDeliveryRun } from './erp-delivery.types';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;
const P = 'ZZINC';

jest.setTimeout(300_000);

run('delivery increase requests (real DB, real vouchers path)', () => {
  let app: INestApplicationContext;
  let ds: DataSource;
  let intake: DeliveryIntakeService;
  let increases: DeliveryIncreasesService;
  let deliveries: DeliveriesService;
  let mirror: DeliveryMirrorService;
  let repD = '';
  let repS = '';
  let userD = '';
  let office = '';
  let cust = '';
  let water = '';
  let juice = '';
  let settingsBefore: { inc: boolean; proof: boolean; erp: boolean } = { inc: false, proof: true, erp: false };
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params);

  async function purge() {
    await q(`DELETE FROM notifications WHERE ref_type = 'delivery_stop' AND body_en LIKE $1`, [`%${P}%`]);
    await q(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE user_number LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM erp_outbox WHERE ref LIKE $1 OR ref IN (SELECT voucher_number FROM voucher_headers WHERE customer_number LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM payments WHERE voucher_number IN (SELECT voucher_number FROM voucher_headers WHERE customer_number LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM voucher_transactions WHERE voucher_number IN (SELECT voucher_number FROM voucher_headers WHERE customer_number LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM voucher_headers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM van_stock WHERE rep_id IN (SELECT id FROM reps WHERE code LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM voucher_inbox WHERE client_ref LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM delivery_increase_requests WHERE client_ref LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM delivery_runs WHERE erp_id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customer_prices WHERE erp_sku LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM item_cart WHERE item_number LIKE $1`, [`${P}%`]);
    await q(`UPDATE reps SET user_id = NULL WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM warehouses WHERE wh_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
  }

  beforeAll(async () => {
    // Loaded here, not at the top: importing the whole application graph in a
    // run without a database (where this suite is skipped) crashes the worker.
    const { AppModule } = await import('../../app.module');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = await mod.init();
    ds = app.get(DataSource);
    intake = app.get(DeliveryIntakeService);
    increases = app.get(DeliveryIncreasesService);
    deliveries = app.get(DeliveriesService);
    mirror = app.get(DeliveryMirrorService);
    await purge();

    [{ inc: settingsBefore.inc, proof: settingsBefore.proof, erp: settingsBefore.erp }] = await q(
      `SELECT delivery_increase_requests AS inc, delivery_proof_required AS proof, erp_sync_enabled AS erp
         FROM app_settings WHERE id = 1`,
    );
    // ERP on with no key: the voucher path queues its SALES_ORDER row and the
    // drain, finding no key, sends nothing anywhere.
    await q(`UPDATE app_settings SET delivery_proof_required = false, erp_sync_enabled = true WHERE id = 1`);
    const enc: Array<{ k: string | null }> = await q(`SELECT erp_api_key_encrypted AS k FROM app_settings WHERE id = 1`);
    expect(enc[0]?.k ?? null).toBeNull();

    const mkUser = async (n: string, name: string, role: string, type: string) =>
      (
        await q<{ id: string }>(
          `INSERT INTO users (user_number, name, password_hash, user_type, role, is_active)
           VALUES ($1, $2, 'x', $3, $4, true) RETURNING id`,
          [n, name, type, role],
        )
      )[0].id;
    userD = await mkUser(`${P}D`, 'Driver', 'viewer', 'SALES');
    office = await mkUser(`${P}A`, 'Office Admin', 'admin', 'ADMIN');
    // The customer's salesman has his login, as provisioning always gives one.
    await mkUser(`${P}S`, 'Salesman', 'viewer', 'SALES');
    const mkRep = async (code: string, kind: string, userId: string | null) => {
      const [{ id: wh }] = await q<{ id: string }>(
        `INSERT INTO warehouses (wh_number, wh_name) VALUES ($1, $1) RETURNING id`,
        [code],
      );
      return (
        await q<{ id: string }>(
          `INSERT INTO reps (code, name_ar, kind, user_id, van_id) VALUES ($1, $1, $2, $3, $4) RETURNING id`,
          [code, kind, userId, wh],
        )
      )[0].id;
    };
    repD = await mkRep(`${P}D`, 'DELIVERY', userD);
    repS = await mkRep(`${P}S`, 'SALES', null);
    [{ id: cust }] = await q<{ id: string }>(
      `INSERT INTO customers (customer_number, customer_name, name_ar, rep_id)
       VALUES ($1, 'Shop', 'زبون', $2) RETURNING id`,
      [`${P}C1`, repS],
    );
    const mkItem = async (n: string, name: string, price: number) =>
      (
        await q<{ id: string }>(
          `INSERT INTO item_cart (item_number, item_name, barcode, sku, name_ar, name_en, price, tax_percentage, tax_rate, unit)
           VALUES ($1, $2, $1, $1, $2, $2, $3, 16, 0.16, 'CTN') RETURNING id`,
          [n, name, price],
        )
      )[0].id;
    water = await mkItem(`${P}W`, 'Water', 1500);
    juice = await mkItem(`${P}J`, 'Juice', 2000);
    // The customer's contract price for water — the order must use it, not the list price.
    await q(
      `INSERT INTO customer_prices (customer_id, item_id, erp_sku, unit_price) VALUES ($1, $2, $3, 1250)`,
      [cust, water, `${P}W`],
    );

    const erpRun: ErpDeliveryRun = {
      id: `${P}-run`,
      runNumber: `${P}-DR`,
      runDate: '2026-11-08',
      status: 'OPEN',
      updatedAt: '2026-11-08T08:00:00.000Z',
      driver: { type: 'SALESMAN', salesmanCode: `${P}D`, name: 'Driver' },
      items: ['1', '2', '3'].map((n) => ({
        id: `${P}-item-${n}`,
        sequence: Number(n),
        status: 'LOADED',
        invoice: {
          id: `${P}-inv-${n}`,
          invoiceNumber: `${P}-INV-${n}`,
          customerCode: `${P}C1`,
          customerName: 'Shop',
          totalAmount: 10,
          taxAmount: 0,
          amountPaid: 0,
          lines: [{ id: `${P}-line-${n}`, lineNo: 1, skuCode: `${P}W`, nameEn: 'Water', quantity: 5, unitPrice: 2, taxRate: 0, lineTotal: 10 }],
        },
      })),
    };
    await mirror.applyRun(erpRun);
  }, 300_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await q(
      `UPDATE app_settings SET delivery_increase_requests = $1, delivery_proof_required = $2, erp_sync_enabled = $3 WHERE id = 1`,
      [settingsBefore.inc, settingsBefore.proof, settingsBefore.erp],
    );
    await purge();
    await app.close();
  });

  const stopId = async (n: string) =>
    (await q<{ id: string }>(`SELECT id FROM delivery_stops WHERE erp_id = $1`, [`${P}-item-${n}`]))[0].id;
  const asDriver = () => ({ sub: userD, repId: repD, role: 'viewer', userType: 'SALES' }) as never;
  const asOffice = () => ({ sub: office, role: 'admin', userType: 'ADMIN', userNumber: `${P}A` }) as never;
  const result = async (n: string, over: Record<string, unknown> = {}) => ({
    clientRef: `${P}-ref-${n}`,
    stopId: await stopId(n),
    outcome: 'DELIVERED',
    deliveredAt: '2026-11-08T10:00:00+03:00',
    ...over,
  });

  it('switch off: the increase is ignored and the delivery goes through', async () => {
    await q(`UPDATE app_settings SET delivery_increase_requests = false WHERE id = 1`);
    const out = await intake.ingest((await result('1', { increase: [{ productId: water, qty: 2 }] })) as never, asDriver());
    expect(out).toEqual({ status: 'accepted' });
    expect(await q(`SELECT 1 FROM delivery_increase_requests WHERE client_ref = $1`, [`${P}-ref-1`])).toEqual([]);
    const [{ payload }] = await q<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM voucher_inbox WHERE client_ref = $1`,
      [`${P}-ref-1`],
    );
    expect(payload).not.toHaveProperty('increase');
  });

  it('switch on: stored with names snapshotted, sent to the ERP, managers told; the Stop carries it', async () => {
    await q(`UPDATE app_settings SET delivery_increase_requests = true WHERE id = 1`);
    const before = await q<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'delivery.increase_requested'`);
    const out = await intake.ingest(
      (await result('2', { increase: [{ productId: water, qty: 3 }, { productId: juice, qty: 2 }] })) as never,
      asDriver(),
    );
    expect(out).toEqual({ status: 'accepted' });
    const [row] = await q<{ status: string; customer_id: string; rep_id: string; invoice_number: string; lines: unknown[] }>(
      `SELECT status, customer_id, rep_id, invoice_number, lines FROM delivery_increase_requests WHERE client_ref = $1`,
      [`${P}-ref-2`],
    );
    expect(row).toMatchObject({ status: 'PENDING', customer_id: cust, rep_id: repD, invoice_number: `${P}-INV-2` });
    expect(row.lines).toEqual([
      { productId: water, skuCode: `${P}W`, nameAr: 'Water', nameEn: 'Water', unit: 'CTN', qty: 3 },
      { productId: juice, skuCode: `${P}J`, nameAr: 'Juice', nameEn: 'Juice', unit: 'CTN', qty: 2 },
    ]);
    const [{ payload }] = await q<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM voucher_inbox WHERE client_ref = $1`,
      [`${P}-ref-2`],
    );
    expect(payload.increase).toEqual([
      { skuCode: `${P}W`, qty: 3 },
      { skuCode: `${P}J`, qty: 2 },
    ]);
    const after = await q<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'delivery.increase_requested'`);
    expect(after[0].n).toBeGreaterThan(before[0].n);

    // The replayed result makes no second request.
    await intake.ingest((await result('2', { increase: [{ productId: water, qty: 3 }] })) as never, asDriver());
    expect(await q(`SELECT 1 FROM delivery_increase_requests WHERE client_ref = $1`, [`${P}-ref-2`])).toHaveLength(1);

    // Phone and dashboard Stop views both carry it.
    const phone = await deliveries.appStop(asDriver(), await stopId('2'));
    expect(phone.increaseRequest).toMatchObject({ status: 'PENDING', orderVoucherNumber: null });
    const dash = await deliveries.stopByInvoice(`${P}-INV-2`);
    expect(dash.increaseRequest?.lines).toHaveLength(2);

    const list = await increases.list({ status: 'PENDING', customerId: cust });
    expect(list.items[0]).toMatchObject({
      status: 'PENDING',
      run: { runNumber: `${P}-DR` },
      stop: { invoiceNumber: `${P}-INV-2` },
      customer: { id: cust, customerNumber: `${P}C1` },
      rep: { id: repD, code: `${P}D` },
      order: null,
    });
    expect((await increases.count()).pending).toBeGreaterThanOrEqual(1);
  });

  it("/order: ONE ORDER through the vouchers path — customer, his salesman, contract price, tax, CREDIT, SALES_ORDER outbox", async () => {
    const [{ id: reqId }] = await q<{ id: string }>(
      `SELECT id FROM delivery_increase_requests WHERE client_ref = $1`,
      [`${P}-ref-2`],
    );
    const out = await increases.order(reqId, { note: 'deliver Thursday' }, asOffice(), `${P}-click-1`);
    const vn = out.order.voucherNumber;
    expect(out.request).toMatchObject({ status: 'ORDERED', decidedBy: 'Office Admin', order: { voucherNumber: vn } });
    expect(out.order.id).toMatch(/^[0-9a-f-]{36}$/);

    const [h] = await q<{
      id: string;
      trans_kind: string;
      customer_number: string;
      user_code: string;
      is_posted: boolean;
      notes: string;
      net_total: string;
    }>(`SELECT id, trans_kind, customer_number, user_code, is_posted, notes, net_total FROM voucher_headers WHERE voucher_number = $1`, [vn]);
    expect(h).toMatchObject({
      id: out.order.id,
      trans_kind: 'ORDER',
      customer_number: `${P}C1`,
      // The customer's own salesman (SALES), not the delivery rep.
      user_code: `${P}S`,
      is_posted: true,
    });
    expect(h.notes).toContain(`From a delivery increase request — invoice ${P}-INV-2`);
    expect(h.notes).toContain('deliver Thursday');
    const lines = await q<{ item_number: string; item_qty: string; unit_price: string; tax_percentage: string }>(
      `SELECT item_number, item_qty, unit_price, tax_percentage FROM voucher_transactions
        WHERE voucher_number = $1 ORDER BY item_number DESC`,
      [vn],
    );
    expect(lines.map((l) => [l.item_number, Number(l.item_qty)])).toEqual([
      [`${P}W`, 3],
      [`${P}J`, 2],
    ]);
    // Priced by the path's pricing: the contract price for water, the list price for juice.
    const priceOf = (n: string) => Number(lines.find((l) => l.item_number === n)!.unit_price);
    const ratio = priceOf(`${P}J`) / priceOf(`${P}W`);
    expect(ratio).toBeCloseTo(2000 / 1250, 3);
    // Tax from the item record.
    expect(lines.every((l) => Number(l.tax_percentage) === 16)).toBe(true);
    expect(out.order.totalFils).toBe(Math.round(Number(h.net_total) * 1000));
    const pays = await q<{ payment_type: string }>(`SELECT payment_type FROM payments WHERE voucher_number = $1`, [vn]);
    expect(pays.map((p) => p.payment_type)).toEqual(['CREDIT']);
    expect(await q(`SELECT kind FROM erp_outbox WHERE ref = $1`, [vn])).toEqual([{ kind: 'SALES_ORDER' }]);

    const [r] = await q<{ status: string; order_voucher_number: string; order_voucher_id: string }>(
      `SELECT status, order_voucher_number, order_voucher_id FROM delivery_increase_requests WHERE id = $1`,
      [reqId],
    );
    expect(r).toEqual({ status: 'ORDERED', order_voucher_number: vn, order_voucher_id: out.order.id });

    // The delivery rep is told.
    const told = await q<{ body_ar: string }>(
      `SELECT body_ar FROM notifications WHERE user_id = $1 AND kind = 'delivery.increase_ordered'`,
      [userD],
    );
    expect(told.map((t) => t.body_ar)).toEqual([`طلب الزيادة للفاتورة ${P}-INV-2 أُنشئ كأمر بيع ${vn}`]);

    // The same key: the same order, no second voucher.
    const again = await increases.order(reqId, {}, asOffice(), `${P}-click-1`);
    expect(again.order).toEqual(out.order);
    expect(await q(`SELECT 1 FROM voucher_headers WHERE customer_number = $1 AND trans_kind = 'ORDER'`, [`${P}C1`])).toHaveLength(1);
    // A second decision: 409.
    await expect(increases.order(reqId, {}, asOffice(), `${P}-click-2`)).rejects.toBeInstanceOf(ConflictException);
    await expect(increases.dismiss(reqId, { note: 'x' }, asOffice(), `${P}-click-3`)).rejects.toMatchObject({
      response: { code: 'INCREASE_ALREADY_DECIDED' },
    });
    // The phone sees the order number on the stop.
    expect((await deliveries.appStop(asDriver(), await stopId('2'))).increaseRequest).toMatchObject({
      status: 'ORDERED',
      orderVoucherNumber: vn,
    });
  });

  it('dismiss: the note is kept, the rep is told, the stop shows it', async () => {
    await intake.ingest(
      (await result('3', { outcome: 'RETURNED', increase: [{ productId: juice, qty: 1 }] })) as never,
      asDriver(),
    );
    const [{ id: reqId }] = await q<{ id: string }>(
      `SELECT id FROM delivery_increase_requests WHERE client_ref = $1`,
      [`${P}-ref-3`],
    );
    const out = await increases.dismiss(reqId, { note: `${P} no stock this week` }, asOffice(), `${P}-click-4`);
    expect(out.request).toMatchObject({ status: 'DISMISSED', decisionNote: `${P} no stock this week`, order: null });
    const told = await q<{ body_en: string }>(
      `SELECT body_en FROM notifications WHERE user_id = $1 AND kind = 'delivery.increase_dismissed'`,
      [userD],
    );
    expect(told.map((t) => t.body_en)).toEqual([`Increase request dismissed: ${P} no stock this week`]);
    expect((await deliveries.appStop(asDriver(), await stopId('3'))).increaseRequest).toMatchObject({
      status: 'DISMISSED',
      decisionNote: `${P} no stock this week`,
    });
    const decided = await increases.list({ status: 'DECIDED', customerId: cust });
    expect(decided.items.map((i) => i.status).sort()).toEqual(['DISMISSED', 'ORDERED']);
  });
});
