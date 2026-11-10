/**
 * Real-DB: the CashVan RETURN voucher an approved delivery return becomes.
 *
 *  - created ONCE however it is reached: the dashboard's approve, the ERP's own
 *    screen seen through the mirror, a retried approve, every re-read, the
 *    backfill;
 *  - never pushed: no outbox row, and the real outbox sweep (backdated past its
 *    grace window) queues an ordinary return but not this one; the manual
 *    export refuses it;
 *  - its totals are the credit note's, to the fil, and its lines add up to them;
 *  - the original salesman owns it: the CashVan sale's seller, else the ERP
 *    invoice's rep, else the customer's salesman, else the delivery rep (a rep
 *    without a login is passed over);
 *  - no stock moves, no balance moves.
 *
 * Skipped unless DB_NAME points at a database with the schema applied. Creates
 * and removes everything under ZZRV.
 */
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ErpSyncCursor } from '../erp-sync/entities/erp-sync-cursor.entity';
import { ErpOutboxSweepService } from '../erp-sync/erp-outbox-sweep.service';
import { ErpSyncService } from '../erp-sync/erp-sync.service';
import { VoucherHeader } from '../vouchers/entities/voucher-header.entity';
import { Rep } from '../reps/entities/rep.entity';
import { DeliveriesService } from './deliveries.service';
import { ErpRefusedError } from './delivery-erp.client';
import { DeliveryMirrorService } from './delivery-mirror.service';
import { DeliveryReturnsService } from './delivery-returns.service';
import { DeliveryReturnVoucherService } from './delivery-return-voucher.service';
import { DeliveryRun } from './entities/delivery-run.entity';
import { DeliveryStop } from './entities/delivery-stop.entity';
import { DeliveryStopLine } from './entities/delivery-stop-line.entity';
import { DeliveryProof } from './entities/delivery-proof.entity';
import type { ErpDeliveryItem, ErpDeliveryRun } from './erp-delivery.types';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;
const P = 'ZZRV';

run('delivery return → CashVan RETURN voucher (real DB)', () => {
  let ds: DataSource;
  let mirror: DeliveryMirrorService;
  let bareMirror: DeliveryMirrorService;
  let vouchers: DeliveryReturnVoucherService;
  let returns: DeliveryReturnsService;
  const ids: Record<string, string> = {};
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params);
  const erp = {
    isEnabled: async () => true,
    getRun: jest.fn(),
    approveReturn: jest.fn(),
    rejectReturn: jest.fn(),
  };

  async function purge() {
    await q(`DELETE FROM erp_outbox WHERE ref LIKE $1 OR ref LIKE $2`, [`ERP-RET-${P}%`, `${P}%`]);
    await q(`DELETE FROM erp_id_map WHERE entity = 'voucher' AND (erp_id LIKE $1 OR erp_id LIKE $2)`, [`ERP-RET-${P}%`, `${P}%`]);
    await q(`DELETE FROM voucher_headers WHERE voucher_number LIKE $1 OR voucher_number LIKE $2`, [`ERP-RET-${P}%`, `${P}%`]);
    await q(`DELETE FROM delivery_runs WHERE erp_id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM erp_invoices WHERE erp_id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM item_cart WHERE item_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
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
    await purge();
    // The vouchers service seeds these at boot; a bare test database has none.
    await q(
      `INSERT INTO transaction_kinds (trans_kind, trans_name, sign) VALUES ('SALE','بيع',-1), ('RETURN','مرتجع',1)
       ON CONFLICT (trans_kind) DO NOTHING`,
    );

    // Reps — S sold, I is the invoice's rep, C the customer's, D drove, N has no login.
    for (const [code, kind, login] of [
      ['S', 'SALES', true],
      ['I', 'SALES', true],
      ['C', 'SALES', true],
      ['D', 'DELIVERY', true],
      ['N', 'SALES', false],
    ] as const) {
      if (login) {
        await q(`INSERT INTO users (user_number, name, password_hash, user_type, role) VALUES ($1, $1, 'x', 'SALES', 'viewer')`, [
          `${P}${code}`,
        ]);
      }
      ids[`rep${code}`] = (
        await q<{ id: string }>(`INSERT INTO reps (code, name_ar, kind) VALUES ($1, $2, $3) RETURNING id`, [
          `${P}${code}`,
          `مندوب ${code}`,
          kind,
        ])
      )[0].id;
    }
    const mkCust = async (n: string, repId: string | null) =>
      (
        await q<{ id: string }>(
          `INSERT INTO customers (customer_number, customer_name, name_ar, rep_id, total_debt)
           VALUES ($1, $1, $1, $2, 100) RETURNING id`,
          [`${P}${n}`, repId],
        )
      )[0].id;
    ids.custC = await mkCust('CC', ids.repC); // salesman C
    ids.custN = await mkCust('CN', ids.repN); // salesman without a login
    await q(
      `INSERT INTO item_cart (item_number, item_name, barcode, sku, name_ar, name_en, price, tax_percentage, tax_rate)
       VALUES ($1, 'Water', $1, $1, 'ماء', 'Water', 1000, 16, 0.16), ($2, 'Juice', $2, $2, 'عصير', 'Juice', 2000, 16, 0.16)`,
      [`${P}W`, `${P}J`],
    );

    // A CashVan van sale, pushed to the ERP as invoice ZZRV-INV-A (id-mapped).
    await q(
      `INSERT INTO voucher_headers (voucher_number, user_code, trans_kind, customer_number, is_posted, total, total_tax, net_total)
       VALUES ($1, $2, 'SALE', $3, true, 10, 1.6, 11.6)`,
      [`${P}-VS-1`, `${P}S`, `${P}CC`],
    );
    await q(
      `INSERT INTO voucher_transactions (voucher_number, item_number, item_name, trans_kind, item_qty, unit_price, tax_percentage, total, net_total)
       VALUES ($1, $2, 'Water', 'SALE', 10, 1, 16, 10, 11.6)`,
      [`${P}-VS-1`, `${P}W`],
    );
    await q(`INSERT INTO erp_id_map (entity, erp_id, local_id, erp_code) VALUES ('voucher', $1, $1, $2)`, [
      `${P}-VS-1`,
      `${P}-INV-A`,
    ]);
    // An office invoice credited to rep I in the invoice mirror.
    await q(
      `INSERT INTO erp_invoices (erp_id, invoice_number, issued_at, customer_id, status, total_fils, paid_fils, rep_id)
       VALUES ($1, $2, now(), $3, 'issued', 11600, 0, $4)`,
      [`${P}-erpinv-B`, `${P}-INV-B`, ids.custC, ids.repI],
    );

    const notifications = { notifyUser: async () => undefined };
    const cursors = ds.getRepository(ErpSyncCursor);
    const events = { emit: () => true };
    vouchers = new DeliveryReturnVoucherService(ds);
    mirror = new DeliveryMirrorService(ds, erp as never, cursors, events as never, notifications as never, vouchers);
    bareMirror = new DeliveryMirrorService(ds, erp as never, cursors, events as never, notifications as never);
    const deliveries = new DeliveriesService(
      ds,
      ds.getRepository(DeliveryRun),
      ds.getRepository(DeliveryStop),
      ds.getRepository(DeliveryStopLine),
      ds.getRepository(Rep),
      { locationMode: async () => 'FLAT' } as never,
      erp as never,
      mirror,
      ds.getRepository(DeliveryProof),
    );
    returns = new DeliveryReturnsService(
      ds,
      ds.getRepository(DeliveryStop),
      ds.getRepository(DeliveryRun),
      ds.getRepository(DeliveryStopLine),
      ds.getRepository(Rep),
      deliveries,
      erp as never,
      mirror,
      vouchers,
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  // ── the ERP's picture of the run ──────────────────────────────────────────

  type Decision = 'PENDING' | 'APPROVED';
  const stopItem = (key: string, customerCode: string, decision: Decision, cn = `${P}-CN-${key}`): ErpDeliveryItem => ({
    id: `${P}-item-${key}`,
    sequence: key.charCodeAt(0),
    status: 'PARTIAL',
    returnStatus: decision,
    deliveredAt: '2026-11-09T07:00:00.000Z',
    results: [
      {
        invoiceItemId: `${P}-line-${key}-1`,
        invoicedQty: 10,
        deliveredQty: 6,
        reasonCode: 'DAMAGED',
        condition: 'DAMAGED',
        approvedQty: decision === 'APPROVED' ? 3 : null,
      },
      {
        invoiceItemId: `${P}-line-${key}-2`,
        invoicedQty: 4,
        deliveredQty: 3,
        reasonCode: 'WRONG_ITEM',
        condition: 'GOOD',
        approvedQty: decision === 'APPROVED' ? 1 : null,
      },
    ],
    returnDecidedAt: decision === 'APPROVED' ? '2026-11-09T09:00:00.000Z' : null,
    returnDecidedBy: decision === 'APPROVED' ? 'Office Admin' : null,
    returnDecisionNote: decision === 'APPROVED' ? 'checked at the warehouse' : null,
    // 3 waters at 11.600/10 + 1 juice at 9.280/4 = 3.480 + 2.320 = 5.800, tax 0.800.
    creditNote:
      decision === 'APPROVED'
        ? { id: `cn-${key}`, number: cn, total: 5.8, taxTotal: 0.8, jofotara: { status: 'SUBMITTED', qrCode: `QR-${key}`, uuid: `u-${key}` } }
        : null,
    invoice: {
      id: `${P}-erpinv-${key}`,
      invoiceNumber: `${P}-INV-${key}`,
      customerCode,
      totalAmount: 20.88,
      taxAmount: 2.88,
      amountPaid: 0,
      lines: [
        { id: `${P}-line-${key}-1`, lineNo: 1, skuCode: `${P}W`, nameEn: 'Water', quantity: 10, unitPrice: 1, taxRate: 16, lineTotal: 11.6 },
        { id: `${P}-line-${key}-2`, lineNo: 2, skuCode: `${P}J`, nameEn: 'Juice', quantity: 4, unitPrice: 2, taxRate: 16, lineTotal: 9.28 },
      ],
    },
  });
  const erpRun = (updatedAt: string, items: ErpDeliveryItem[], id = `${P}-run`): ErpDeliveryRun => ({
    id,
    runNumber: `${P}-DR`,
    runDate: '2026-11-09',
    status: 'OPEN',
    updatedAt,
    driver: { type: 'SALESMAN', salesmanCode: `${P}D`, name: 'Driver' },
    items,
  });
  const voucherOf = async (key: string) =>
    (
      await q<{
        voucher_number: string;
        trans_kind: string;
        user_code: string;
        customer_number: string;
        reference_voucher_number: string | null;
        is_posted: boolean;
        net_total: string;
        total_tax: string;
        total: string;
        notes: string;
        jofotara_qr_code: string | null;
        jofotara_status: string | null;
      }>(`SELECT * FROM voucher_headers WHERE voucher_number = $1`, [`ERP-RET-${P}-CN-${key}`])
    )[0];
  const count = async (key: string) =>
    (await q(`SELECT 1 FROM voucher_headers WHERE voucher_number = $1`, [`ERP-RET-${P}-CN-${key}`])).length;

  it('the dashboard approve makes the voucher: the sale’s seller, the sale referenced, the credit note’s totals', async () => {
    await mirror.applyRun(erpRun('2026-11-09T08:00:00.000Z', [stopItem('A', `${P}CC`, 'PENDING')]));
    expect(await count('A')).toBe(0);
    const stopA = (await q<{ id: string }>(`SELECT id FROM delivery_stops WHERE erp_id = $1`, [`${P}-item-A`]))[0].id;

    const approved = stopItem('A', `${P}CC`, 'APPROVED');
    erp.approveReturn.mockResolvedValueOnce({ item: approved, creditNote: approved.creditNote });
    erp.getRun.mockResolvedValueOnce(erpRun('2026-11-09T09:00:00.000Z', [approved]));
    const out = await returns.approve(stopA, {}, { sub: '00000000-0000-4000-8000-0000000000aa' } as never, 'click-1');

    const v = await voucherOf('A');
    expect(out.returnVoucher).toEqual({ id: expect.any(String), voucherNumber: `ERP-RET-${P}-CN-A` });
    expect(out.stop.returnVoucher).toEqual(out.returnVoucher);
    expect(v).toMatchObject({
      trans_kind: 'RETURN',
      user_code: `${P}S`, // the seller of the CashVan sale the invoice came from
      customer_number: `${P}CC`,
      reference_voucher_number: `${P}-VS-1`,
      is_posted: true,
      jofotara_qr_code: 'QR-A',
      jofotara_status: 'SUBMITTED',
    });
    expect(v.notes).toContain(`Delivery return — run ${P}-DR — invoice ${P}-INV-A — credit note ${P}-CN-A`);
    expect(v.notes).toContain('checked at the warehouse');

    // The credit note's numbers, to the fil, and the lines add up to them.
    expect(Math.round(Number(v.net_total) * 1000)).toBe(5800);
    expect(Math.round(Number(v.total_tax) * 1000)).toBe(800);
    const lines = await q<{ item_number: string; item_qty: string; net_total: string; total: string; store_number: string | null; from_store_number: string | null; to_store_number: string | null }>(
      `SELECT item_number, item_qty, net_total, total, store_number, from_store_number, to_store_number
         FROM voucher_transactions WHERE voucher_number = $1 ORDER BY item_number DESC`,
      [v.voucher_number],
    );
    expect(lines.map((l) => [l.item_number, Number(l.item_qty)])).toEqual([
      [`${P}W`, 3],
      [`${P}J`, 1],
    ]);
    expect(lines.reduce((s, l) => s + Math.round(Number(l.net_total) * 1000), 0)).toBe(5800);
    expect(lines.reduce((s, l) => s + Math.round((Number(l.net_total) - Number(l.total)) * 1000), 0)).toBe(800);
    expect(lines.every((l) => !l.store_number && !l.from_store_number && !l.to_store_number)).toBe(true);
    const pays = await q<{ payment_type: string; amount: string }>(`SELECT payment_type, amount FROM payments WHERE voucher_number = $1`, [v.voucher_number]);
    expect(pays.map((p) => [p.payment_type, Math.round(Number(p.amount) * 1000)])).toEqual([['CREDIT', 5800]]);
    // Its ERP document is the credit note.
    expect(await q(`SELECT erp_code FROM erp_id_map WHERE entity = 'voucher' AND erp_id = $1`, [v.voucher_number])).toEqual([
      { erp_code: `${P}-CN-A` },
    ]);
    // The sale can no longer be returned for what came back.
    expect(await q(`SELECT qty_returned::float8 AS r FROM voucher_transactions WHERE voucher_number = $1`, [`${P}-VS-1`])).toEqual([{ r: 3 }]);
  });

  it('exactly once: a retried approve (already decided), a re-read, the mirror again', async () => {
    const stopA = (await q<{ id: string }>(`SELECT id FROM delivery_stops WHERE erp_id = $1`, [`${P}-item-A`]))[0].id;
    erp.approveReturn.mockRejectedValueOnce(new ErpRefusedError(409, 'RETURN_ALREADY_DECIDED', 'decided'));
    await expect(returns.approve(stopA, {}, { sub: '00000000-0000-4000-8000-0000000000aa' } as never, 'click-2')).rejects.toMatchObject({ status: 409 });
    await mirror.applyRun(erpRun('2026-11-09T09:30:00.000Z', [stopItem('A', `${P}CC`, 'APPROVED')]));
    await mirror.applyRun(erpRun('2026-11-09T09:31:00.000Z', [stopItem('A', `${P}CC`, 'APPROVED')]));
    expect((await vouchers.ensureFor(stopA)).status).toBe('exists');
    expect(await count('A')).toBe(1);
    expect(await q(`SELECT 1 FROM payments WHERE voucher_number = $1`, [`ERP-RET-${P}-CN-A`])).toHaveLength(1);
  });

  it('approved in the ERP’s own screen: the mirror makes it; the rep falls back through the invoice, the customer, the driver', async () => {
    await mirror.applyRun(
      erpRun(
        '2026-11-09T10:00:00.000Z',
        [
          stopItem('B', `${P}CC`, 'APPROVED'), // the invoice mirror credits rep I
          stopItem('C', `${P}CC`, 'APPROVED'), // nothing but the customer's salesman C
          stopItem('D', `${P}CN`, 'APPROVED'), // customer's salesman has no login → the driver
        ],
        `${P}-run-2`,
      ),
    );
    expect((await voucherOf('B')).user_code).toBe(`${P}I`);
    expect((await voucherOf('C')).user_code).toBe(`${P}C`);
    expect((await voucherOf('D')).user_code).toBe(`${P}D`);
    for (const k of ['B', 'C', 'D']) {
      expect((await voucherOf(k)).reference_voucher_number).toBeNull();
      expect(await count(k)).toBe(1);
    }
  });

  it('never pushed: no outbox row; the real sweep queues an ordinary return but not these; export refuses them', async () => {
    expect(await q(`SELECT ref FROM erp_outbox WHERE ref LIKE $1`, [`ERP-RET-${P}%`])).toEqual([]);
    // Past the sweep's 10-minute grace, with a control: an ordinary posted return.
    await q(`UPDATE voucher_headers SET created_at = now() - interval '2 hours' WHERE voucher_number LIKE $1`, [`ERP-RET-${P}%`]);
    await q(
      `INSERT INTO voucher_headers (voucher_number, user_code, trans_kind, customer_number, is_posted, created_at)
       VALUES ($1, $2, 'RETURN', $3, true, now() - interval '2 hours')`,
      [`${P}-RET-CTRL`, `${P}S`, `${P}CC`],
    );
    const queued: Array<[string, string]> = [];
    const sweep = new ErpOutboxSweepService(
      ds,
      { getErpConfig: async () => ({ enabled: true }) } as never,
      { enqueue: async (kind: string, ref: string) => void queued.push([kind, ref]) } as never,
    );
    await sweep.sweep();
    expect(queued).toContainEqual(['SALES_RETURN', `${P}-RET-CTRL`]); // the sweep did run
    expect(queued.filter(([, ref]) => ref.startsWith('ERP-RET-'))).toEqual([]);

    const sync = Object.create(ErpSyncService.prototype) as ErpSyncService & Record<string, unknown>;
    (sync as Record<string, unknown>).headers = ds.getRepository(VoucherHeader);
    (sync as Record<string, unknown>).outbox = { enqueue: jest.fn() };
    await expect(sync.exportVoucher(`ERP-RET-${P}-CN-A`)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no stock and no balance moves', async () => {
    expect(await q(`SELECT 1 FROM stock_movements WHERE voucher_number LIKE $1`, [`ERP-RET-${P}%`])).toEqual([]);
    expect(await q(`SELECT 1 FROM van_stock WHERE rep_id IN (SELECT id FROM reps WHERE code LIKE $1)`, [`${P}%`])).toEqual([]);
    expect(
      await q<{ d: number }>(`SELECT total_debt::float8 AS d FROM customers WHERE customer_number LIKE $1 ORDER BY 1`, [`${P}%`]),
    ).toEqual([{ d: 100 }, { d: 100 }]);
  });

  it('the backfill makes what is missing, once', async () => {
    // Approved while nothing made vouchers (a mirror without the service).
    await bareMirror.applyRun(erpRun('2026-11-09T11:00:00.000Z', [stopItem('E', `${P}CC`, 'APPROVED')], `${P}-run-3`));
    expect(await count('E')).toBe(0);
    const first = await vouchers.backfill();
    expect(first.created).toBeGreaterThanOrEqual(1);
    expect(await count('E')).toBe(1);
    const again = await vouchers.backfill();
    expect(again.created).toBe(0);
    expect(await count('E')).toBe(1);
  });
});
