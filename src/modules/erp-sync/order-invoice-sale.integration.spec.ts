/**
 * Real-DB: a salesman's ORDER, invoiced by the office in the ERP, comes back
 * as HIS sale — returnable, counted once, and without moving van stock.
 *
 * Runs the real sync path (applyErpInvoice) against the real schema, with the
 * ERP client stubbed to answer the invoice the office generated from the order,
 * and reads the result back through the real target query.
 *
 * Skipped unless DB_NAME points at a database with the schema applied.
 */
import { DataSource } from 'typeorm';

import { ErpSyncService } from './erp-sync.service';
import { TargetsService } from '../targets/targets.service';
import { ReturnCandidatesService } from '../vouchers/returns/candidates';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

const P = 'ZZOIS';
const STORE = `${P}-V1`;
const ITEM = `${P}-I1`;
const ORDER = `ORD-${P}-1`;
const INVOICE = `INV-${P}-1`;
const SALE = `ERP-${INVOICE}`;
const ERP_ID = '00000000-0000-4000-8000-00000000f001';

run('an invoiced order becomes the salesman sale (real DB)', () => {
  let ds: DataSource;
  let svc: ErpSyncService;
  let targets: TargetsService;
  let repId = '';
  let otherRepId = '';
  let productId = '';
  const userCode = `${P}-U1`;
  const customerNumber = `${P}-C1`;

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  const invoice = (over: Record<string, unknown> = {}) => ({
    id: ERP_ID,
    invoiceNumber: INVOICE,
    customerId: null,
    status: 'issued',
    totalAmount: 11.6,
    totalTax: 1.6,
    amountPaid: 0,
    issuedAt: '2026-03-10T09:00:00.000Z',
    updatedAt: '2026-03-10T09:00:00.000Z',
    paymentType: 'CREDIT',
    origin: 'ERP',
    externalId: null,
    salesOrderExternalRef: ORDER,
    ...over,
  });

  const detail = {
    id: ERP_ID,
    invoiceNumber: INVOICE,
    status: 'issued',
    issuedAt: '2026-03-10T09:00:00.000Z',
    paymentType: 'CREDIT',
    totalAmount: 11.6,
    totalTax: 1.6,
    totalDiscount: 0,
    items: [
      { skuCode: ITEM, productName: 'ZZ item', quantityBilled: 4, sellingPrice: 2.5, discountAmount: 0, taxAmount: 1.6, lineTotal: 11.6 },
    ],
  };

  async function purge() {
    for (const v of [SALE, ORDER, `RET-${P}-1`]) {
      await q(`DELETE FROM payments WHERE voucher_number = $1`, [v]);
      await q(`DELETE FROM voucher_transactions WHERE voucher_number = $1`, [v]);
    }
    await q(`DELETE FROM voucher_headers WHERE voucher_number IN ($1,$2,$3,$4)`, [`RET-${P}-1`, `SAL-${P}-1`, SALE, ORDER]);
    await q(`DELETE FROM erp_id_map WHERE erp_id = $1 OR local_id = $1`, [SALE]);
    await q(`DELETE FROM erp_invoices WHERE erp_id = $1`, [ERP_ID]);
    await q(`DELETE FROM van_stock WHERE product_id IN (SELECT id FROM item_cart WHERE item_number = $1)`, [ITEM]);
    await q(`DELETE FROM customers WHERE customer_number = $1`, [customerNumber]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM item_cart WHERE item_number = $1`, [ITEM]);
    await q(`DELETE FROM warehouses WHERE wh_number = $1`, [STORE]);
  }

  function makeService(): ErpSyncService {
    const s = Object.create(ErpSyncService.prototype) as Record<string, unknown>;
    s.dataSource = ds;
    s.erp = {
      getOne: async (path: string) => (path === `sales-invoices/${ERP_ID}` ? detail : null),
      list: async () => ({ data: [], total: 0 }),
    };
    s.logger = { log: () => undefined, warn: () => undefined, error: () => undefined };
    s.headers = ds.getRepository('VoucherHeader');
    s.txns = ds.getRepository('VoucherTransaction');
    s.items = ds.getRepository('ItemCart');
    s.itemUnits = ds.getRepository('ItemUnit');
    s.idmap = ds.getRepository('ErpIdMap');
    s.erpInvoices = ds.getRepository('ErpInvoice');
    s.customers = ds.getRepository('Customer');
    return s as unknown as ErpSyncService;
  }

  const apply = (inv: Record<string, unknown>) =>
    (svc as unknown as { applyErpInvoice(i: unknown): Promise<void> }).applyErpInvoice(inv);

  const onHand = async (): Promise<number> => {
    const rows = await q(
      `SELECT COALESCE(SUM(qty),0)::float AS qty FROM item_balance WHERE stock_number = $1 AND item_number = $2`,
      [STORE, ITEM],
    );
    return Number(rows[0]?.qty ?? 0);
  };

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
    svc = makeService();
    targets = new TargetsService(ds, ds.getRepository('SalesTarget') as never);
    await q(`INSERT INTO transaction_kinds (trans_kind, trans_name) VALUES ('SALE','Sale') ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO transaction_kinds (trans_kind, trans_name) VALUES ('ORDER','Order') ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO transaction_kinds (trans_kind, trans_name) VALUES ('RETURN','Return') ON CONFLICT DO NOTHING`);
    await purge();

    const [u] = await q(
      `INSERT INTO users (user_number, name, password_hash, user_type) VALUES ($1,'ZZ Rep','x','SALES') RETURNING id`,
      [userCode],
    );
    const [r] = await q(
      `INSERT INTO reps (user_id, code, name_ar, is_active) VALUES ($1,$2,'ZZ Rep',true) RETURNING id`,
      [u.id, `${P}-R1`],
    );
    repId = r.id;
    const [u2] = await q(
      `INSERT INTO users (user_number, name, password_hash, user_type) VALUES ($1,'ZZ Owner','x','SALES') RETURNING id`,
      [`${P}-U2`],
    );
    const [r2] = await q(
      `INSERT INTO reps (user_id, code, name_ar, is_active) VALUES ($1,$2,'ZZ Owner',true) RETURNING id`,
      [u2.id, `${P}-R2`],
    );
    otherRepId = r2.id;
    await q(
      `INSERT INTO customers (customer_number, customer_name, name_ar, rep_id) VALUES ($1,$1,$1,$2)`,
      [customerNumber, otherRepId],
    );
    await q(`INSERT INTO warehouses (wh_number, wh_name) VALUES ($1,'ZZ Van')`, [STORE]);
    const [item] = await q(
      `INSERT INTO item_cart (item_number, sku, item_name, name_ar, barcode, price)
       VALUES ($1,$1,$1,$1,$1,2500) RETURNING id`,
      [ITEM],
    );
    productId = item.id;

    await q(
      `INSERT INTO voucher_headers (voucher_number, trans_kind, user_code, customer_number, in_date, is_posted, total, net_total)
       VALUES ($1,'ORDER',$2,$3,'2026-03-09',TRUE,10,11.6)`,
      [ORDER, userCode, customerNumber],
    );
    await q(
      `INSERT INTO voucher_transactions
         (voucher_number, item_number, item_name, trans_kind, store_number, item_qty, signed_qty, qty_of_unit, unit_base_qty, stock_unit_code, unit_price)
       VALUES ($1,$2,$2,'ORDER',$3,4,0,4,1,'',2.5)`,
      [ORDER, ITEM, STORE],
    );
    await q(
      `INSERT INTO van_stock (rep_id, product_id, quantity, reserved, stock_unit_code) VALUES ($1,$2,10,4,'')`,
      [repId, productId],
    );
    await q(
      `INSERT INTO erp_invoices (erp_id, invoice_number, issued_at, rep_id, status, origin, total_fils, tax_fils, paid_fils, payment_type)
       VALUES ($1,$2,'2026-03-10',$3,'issued','ERP',11600,1600,0,'CREDIT')`,
      [ERP_ID, INVOICE, otherRepId],
    );
  }, 120_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  it('writes the sale for the salesman who took the order, against that order', async () => {
    const before = await onHand();
    await apply(invoice());

    const [h] = await q(
      `SELECT trans_kind, user_code, customer_number, reference_voucher_number, is_posted, net_total::float AS net
         FROM voucher_headers WHERE voucher_number = $1`,
      [SALE],
    );
    expect(h).toMatchObject({
      trans_kind: 'SALE',
      user_code: userCode,
      customer_number: customerNumber,
      reference_voucher_number: ORDER,
      is_posted: true,
      net: 11.6,
    });

    const lines = await q(
      `SELECT item_number, item_qty::float AS qty, store_number, from_store_number, to_store_number
         FROM voucher_transactions WHERE voucher_number = $1`,
      [SALE],
    );
    expect(lines).toEqual([
      { item_number: ITEM, qty: 4, store_number: STORE, from_store_number: null, to_store_number: null },
    ]);
    expect(await onHand()).toBe(before);

    const [pay] = await q(`SELECT payment_type, amount::float AS amount FROM payments WHERE voucher_number = $1`, [SALE]);
    expect(pay).toEqual({ payment_type: 'CREDIT', amount: 11.6 });

    const [map] = await q(`SELECT erp_code FROM erp_id_map WHERE entity = 'voucher' AND erp_id = $1`, [SALE]);
    expect(map.erp_code).toBe(INVOICE);
  });

  it('closes the order and releases its hold without taking goods off the van', async () => {
    const [o] = await q(`SELECT is_fulfilled FROM voucher_headers WHERE voucher_number = $1`, [ORDER]);
    expect(o.is_fulfilled).toBe(true);
    const [vs] = await q(`SELECT quantity, reserved FROM van_stock WHERE rep_id = $1 AND product_id = $2`, [repId, productId]);
    expect(vs).toEqual({ quantity: 10, reserved: 0 });
  });

  it('counts the sale once, for the salesman who took the order', async () => {
    const [left] = await q(`SELECT count(*)::int AS n FROM erp_invoices WHERE erp_id = $1`, [ERP_ID]);
    expect(left.n).toBe(0);

    const mine = await targets.getForRep(repId, 2026, 3);
    const owner = await targets.getForRep(otherRepId, 2026, 3);
    expect(mine?.actualAmount).toBe(10000);
    expect(owner?.actualAmount ?? 0).toBe(0);
  });

  it('offers the sale to the salesman as something he can return against', async () => {
    const found = await new ReturnCandidatesService(ds).find({
      itemNumbers: [ITEM],
      customerNumber,
      userCode,
    } as never);
    expect(found.map((c) => [c.voucherNumber, c.remaining])).toEqual([[SALE, 4]]);
  });

  it('does it once, however often the invoice is read', async () => {
    await apply(invoice());
    await apply(invoice({ updatedAt: '2026-03-11T09:00:00.000Z' }));
    const [n] = await q(`SELECT count(*)::int AS n FROM voucher_headers WHERE voucher_number = $1`, [SALE]);
    expect(n.n).toBe(1);
    const [vs] = await q(`SELECT reserved FROM van_stock WHERE rep_id = $1 AND product_id = $2`, [repId, productId]);
    expect(vs.reserved).toBe(0);
  });

  it('keeps the sale when the ERP voids the invoice after a return stands against it', async () => {
    await q(
      `INSERT INTO voucher_headers (voucher_number, trans_kind, user_code, customer_number, reference_voucher_number, in_date, is_posted)
       VALUES ($1,'RETURN',$2,$3,$4,'2026-03-12',TRUE)`,
      [`RET-${P}-1`, userCode, customerNumber, SALE],
    );
    await apply(invoice({ status: 'voided' }));
    const [n] = await q(`SELECT count(*)::int AS n FROM voucher_headers WHERE voucher_number = $1`, [SALE]);
    expect(n.n).toBe(1);
    await q(`DELETE FROM voucher_headers WHERE voucher_number = $1`, [`RET-${P}-1`]);
  });

  it('removes the sale when the ERP voids the invoice and nothing was returned', async () => {
    await apply(invoice({ status: 'voided' }));
    const [n] = await q(`SELECT count(*)::int AS n FROM voucher_headers WHERE voucher_number = $1`, [SALE]);
    expect(n.n).toBe(0);
  });

  it('leaves the invoice alone when the order was already sold from the dashboard', async () => {
    await q(`DELETE FROM erp_invoices WHERE erp_id = $1`, [ERP_ID]);
    await q(
      `INSERT INTO voucher_headers (voucher_number, trans_kind, user_code, customer_number, reference_voucher_number, in_date, is_posted)
       VALUES ($1,'SALE',$2,$3,$4,'2026-03-10',TRUE)`,
      [`SAL-${P}-1`, userCode, customerNumber, ORDER],
    );
    await apply(invoice());
    const [n] = await q(`SELECT count(*)::int AS n FROM voucher_headers WHERE voucher_number = $1`, [SALE]);
    expect(n.n).toBe(0);
    const [row] = await q(`SELECT count(*)::int AS n FROM erp_invoices WHERE erp_id = $1`, [ERP_ID]);
    expect(row.n).toBe(1);
    await q(`DELETE FROM erp_invoices WHERE erp_id = $1`, [ERP_ID]);
    await q(`DELETE FROM voucher_headers WHERE voucher_number = $1`, [`SAL-${P}-1`]);
  });

  it('leaves an office invoice that no order produced exactly as before', async () => {
    await apply(invoice({ salesOrderExternalRef: null }));
    const [row] = await q(`SELECT rep_id FROM erp_invoices WHERE erp_id = $1`, [ERP_ID]);
    expect(row).toBeDefined();
    const [n] = await q(`SELECT count(*)::int AS n FROM voucher_headers WHERE voucher_number = $1`, [SALE]);
    expect(n.n).toBe(0);
  });
});
