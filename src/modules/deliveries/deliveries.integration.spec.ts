/**
 * Real-DB: delivery rep, phase 1 (docs/SPEC-delivery-rep.md, contract §B).
 *
 *  - the migration: reps.kind and its CHECK, the company switches;
 *  - the mirror: upsert from an ERP run, customers by code, the stop removed in
 *    the ERP deleted unless its result is in flight;
 *  - the answers: RunSummary / RunDetail / Stop, placeLabel in FLAT and TREE
 *    mode, collectedFils from collections.erp_invoice_number;
 *  - loadable invoices from erp_invoices: status rules, not on an open run,
 *    the location subtree, the flat area, search;
 *  - the intake: SENDING at once, idempotent on clientRef, 409 on a final stop,
 *    the inbox row and the outbox row in one go; the ERP's answer settles it;
 *  - the phone: deliveries/mine, history, a SALES rep refused.
 *
 * Skipped unless DB_NAME points at a database with the schema applied. Creates
 * and removes everything under ZZDLV.
 */
import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ErpSyncCursor } from '../erp-sync/entities/erp-sync-cursor.entity';
import { Rep } from '../reps/entities/rep.entity';
import { SettingsService } from '../settings/settings.service';
import { AppSettings } from '../settings/entities/app-settings.entity';
import { DeliveriesService } from './deliveries.service';
import { DeliveryIntakeService } from './delivery-intake.service';
import { DeliveryMirrorService } from './delivery-mirror.service';
import { DeliveryRun } from './entities/delivery-run.entity';
import { DeliveryStop } from './entities/delivery-stop.entity';
import { DeliveryStopLine } from './entities/delivery-stop-line.entity';
import type { ErpDeliveryItem, ErpDeliveryRun } from './erp-delivery.types';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;
const P = 'ZZDLV';

run('delivery rep phase 1 (real DB)', () => {
  let ds: DataSource;
  let mirror: DeliveryMirrorService;
  let deliveries: DeliveriesService;
  let intake: DeliveryIntakeService;
  let mode: 'FLAT' | 'TREE' = 'FLAT';
  const events: Array<Record<string, unknown>> = [];
  const pushed: string[] = [];
  let repD = '';
  let repS = '';
  let cust1 = '';
  let cust2 = '';
  let cust3 = '';
  let areaId = '';
  let govId = '';
  let locId = '';
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ds.query(sql, params);

  const erp = {
    isEnabled: async () => true,
    getRun: jest.fn(),
    listRunsSince: jest.fn(),
    createRun: jest.fn(),
    patchRun: jest.fn(),
    closeRun: jest.fn(),
    vehicles: jest.fn(),
  };
  const settings = { locationMode: async () => mode };

  const item = (id: string, inv: string, customerCode: string, over: Partial<ErpDeliveryItem> = {}): ErpDeliveryItem => ({
    id: `${P}-${id}`,
    sequence: Number(id.replace(/\D/g, '')) || 0,
    status: 'LOADED',
    resultExternalRef: null,
    invoice: {
      id: `${P}-erpinv-${inv}`,
      invoiceNumber: `${P}-INV-${inv}`,
      issueDate: '2026-11-06',
      customerId: `${P}-erpcust-${customerCode}`,
      customerCode,
      customerName: `Shop ${customerCode}`,
      totalAmount: 11.6,
      taxAmount: 1.6,
      amountPaid: 0,
      paymentType: 'CREDIT',
      jofotaraStatus: 'SUBMITTED',
      jofotaraQrCode: 'QR==',
      lines: [
        { id: `${P}-line-${inv}-1`, lineNo: 1, skuCode: 'W1', nameAr: 'ماء', quantity: 10, unitPrice: 1, taxRate: 16 },
      ],
    },
    ...over,
  });
  const erpRun = (over: Partial<ErpDeliveryRun> = {}): ErpDeliveryRun => ({
    id: `${P}-run-1`,
    runNumber: `${P}-DR-1`,
    runDate: '2026-11-07',
    status: 'OPEN',
    updatedAt: '2026-11-07T08:00:00.000Z',
    driver: { type: 'SALESMAN', salesmanCode: `${P}D`, name: 'Driver' },
    vehicle: { id: 'veh-1', name: 'Truck 1', plateNumber: '1' },
    items: [item('s1', '1', `${P}C1`), item('s2', '2', `${P}C2`)],
    ...over,
  });

  async function purge() {
    await q(`DELETE FROM erp_outbox WHERE ref LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM voucher_inbox WHERE client_ref LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM delivery_runs WHERE erp_id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM collections WHERE note = $1`, [P]);
    await q(`DELETE FROM erp_invoices WHERE erp_id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customer_areas WHERE name_ar LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM locations WHERE name_ar LIKE $1 AND kind = 'AREA'`, [`${P}%`]);
    await q(`DELETE FROM locations WHERE name_ar LIKE $1 AND kind = 'GOVERNORATE'`, [`${P}%`]);
    await q(`DELETE FROM locations WHERE name_ar LIKE $1 AND kind = 'COUNTRY'`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM erp_sync_cursor WHERE entity = 'delivery_runs'`);
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

    [{ id: repD }] = await q<{ id: string }>(
      `INSERT INTO reps (code, name_ar, kind) VALUES ($1, 'مندوب توصيل', 'DELIVERY') RETURNING id`,
      [`${P}D`],
    );
    [{ id: repS }] = await q<{ id: string }>(
      `INSERT INTO reps (code, name_ar, kind) VALUES ($1, 'مندوب مبيعات', 'SALES') RETURNING id`,
      [`${P}S`],
    );
    [{ id: areaId }] = await q<{ id: string }>(
      `INSERT INTO customer_areas (name_ar) VALUES ($1) RETURNING id`,
      [`${P} الجبيهة`],
    );
    // A governorate and an area under it, below the tree's one root (made
    // here when the database has none, and removed again at the end).
    let [root] = await q<{ id: string; path: string }>(
      `SELECT id, path FROM locations WHERE kind = 'COUNTRY' AND deleted_at IS NULL LIMIT 1`,
    );
    if (!root) {
      [root] = await q<{ id: string; path: string }>(
        `INSERT INTO locations (kind, path, depth, name_ar) VALUES ('COUNTRY', '/', 0, $1) RETURNING id, path`,
        [`${P} الأردن`],
      );
      await q(`UPDATE locations SET path = '/' || id || '/' WHERE id = $1`, [root.id]);
      root = { id: root.id, path: `/${root.id}/` };
    }
    [{ id: govId }] = await q<{ id: string }>(
      `INSERT INTO locations (kind, parent_id, path, depth, name_ar) VALUES ('GOVERNORATE', $1, '/', 1, $2) RETURNING id`,
      [root.id, `${P} عمّان`],
    );
    await q(`UPDATE locations SET path = $1 || id || '/' WHERE id = $2`, [root.path, govId]);
    [{ id: locId }] = await q<{ id: string }>(
      `INSERT INTO locations (kind, parent_id, path, depth, name_ar) VALUES ('AREA', $1, '/', 2, $2) RETURNING id`,
      [govId, `${P} خلدا`],
    );
    await q(
      `UPDATE locations SET path = (SELECT path FROM locations WHERE id = $1) || id || '/' WHERE id = $2`,
      [govId, locId],
    );
    const mk = async (n: string, extra: { area?: string; loc?: string; city?: string }) =>
      (
        await q<{ id: string }>(
          `INSERT INTO customers (customer_number, customer_name, name_ar, area_id, location_id, city)
           VALUES ($1, $1, $2, $3, $4, $5) RETURNING id`,
          [n, `زبون ${n}`, extra.area ?? null, extra.loc ?? null, extra.city ?? null],
        )
      )[0].id;
    cust1 = await mk(`${P}C1`, { area: areaId, loc: locId });
    cust2 = await mk(`${P}C2`, { city: 'Zarqa' });
    cust3 = await mk(`${P}C3`, {});

    mirror = new DeliveryMirrorService(
      ds,
      erp as never,
      ds.getRepository(ErpSyncCursor),
      { emit: (name: string, p: Record<string, unknown>) => events.push({ name, ...p }) } as never,
    );
    deliveries = new DeliveriesService(
      ds,
      ds.getRepository(DeliveryRun),
      ds.getRepository(DeliveryStop),
      ds.getRepository(DeliveryStopLine),
      ds.getRepository(Rep),
      settings as never,
      erp as never,
      mirror,
    );
    intake = new DeliveryIntakeService(ds, deliveries, mirror, {
      registerHandler: () => undefined,
      pushRefNow: async (ref: string) => void pushed.push(ref),
    } as never);
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  beforeEach(() => {
    events.length = 0;
    mode = 'FLAT';
  });

  const deliveryRep = () => ({ repId: repD }) as never;
  const runId = async () =>
    (await q<{ id: string }>(`SELECT id FROM delivery_runs WHERE erp_id = $1`, [`${P}-run-1`]))[0].id;
  const stopId = async (erp: string) =>
    (await q<{ id: string }>(`SELECT id FROM delivery_stops WHERE erp_id = $1`, [`${P}-${erp}`]))[0].id;

  it('migration: reps.kind defaults to SALES and is checked; switches have their defaults', async () => {
    const [r] = await q<{ kind: string }>(
      `INSERT INTO reps (code, name_ar) VALUES ($1, 'x') RETURNING kind`,
      [`${P}X`],
    );
    expect(r.kind).toBe('SALES');
    await expect(q(`UPDATE reps SET kind = 'DRIVER' WHERE code = $1`, [`${P}X`])).rejects.toThrow();
    const [s] = await q<{ a: boolean; b: boolean }>(
      `SELECT delivery_increase_requests AS a, delivery_proof_required AS b FROM app_settings WHERE id = 1`,
    );
    expect(s).toEqual({ a: false, b: true });
    const svc = new SettingsService(ds.getRepository(AppSettings), {} as never, {} as never);
    expect(await svc.hasDeliveryReps()).toBe(true);
  });

  it('mirrors a run: stops, lines, fils, rep, customers; answers RunDetail with placeLabel', async () => {
    await mirror.applyRun(erpRun());
    const detail = await deliveries.runDetail(await runId());
    expect(detail).toMatchObject({
      erpId: `${P}-run-1`,
      runNumber: `${P}-DR-1`,
      runDate: '2026-11-07',
      status: 'OPEN',
      rep: { id: repD, code: `${P}D` },
      driverCode: `${P}D`,
      vehicleName: 'Truck 1',
      stopsTotal: 2,
      counts: { loaded: 2, delivered: 0, partial: 0, returned: 0, sending: 0 },
      collectedFils: 0,
      returns: { pending: 0, approved: 0, rejected: 0 },
    });
    const [s1, s2] = detail.stops;
    expect(s1).toMatchObject({
      invoiceNumber: `${P}-INV-1`,
      totalFils: 11600,
      taxFils: 1600,
      status: 'LOADED',
      displayStatus: 'LOADED',
      jofotaraQr: 'QR==',
      customer: { id: cust1, customerNumber: `${P}C1`, placeLabel: `${P} الجبيهة` },
    });
    expect(s1.lines[0]).toMatchObject({ invoicedQty: 10, unitPriceFils: 1000, taxRate: 16 });
    // FLAT, no area: the city.
    expect(s2.customer).toMatchObject({ id: cust2, placeLabel: 'Zarqa' });
    expect(events.some((e) => e.name === 'delivery.changed' && e.repId === repD)).toBe(true);

    mode = 'TREE';
    const tree = await deliveries.runDetail(await runId());
    expect(tree.stops[0].customer?.placeLabel).toBe(`${P} عمّان - ${P} خلدا`);

    const list = await deliveries.listRuns({ date: '2026-11-07', repId: repD });
    expect(list.items.map((r) => r.erpId)).toContain(`${P}-run-1`);
    expect(list.items[0]).not.toHaveProperty('stops');
  });

  it('loadable invoices: issued/partially paid, not on an open run, subtree, area, search, paid on request', async () => {
    const inv = (n: string, cust: string | null, status: string, paid = 0) =>
      q(
        `INSERT INTO erp_invoices (erp_id, invoice_number, issued_at, customer_id, status, total_fils, paid_fils, rep_id, salesman_name)
         VALUES ($1, $2, '2026-11-05T09:00:00Z', $3, $4, 10000, $5, $6, 'x')`,
        [`${P}-erpinv-${n}`, `${P}-INV-${n}`, cust, status, paid, n === '6' ? repS : null],
      );
    await inv('1', cust1, 'issued'); // on the open run, LOADED → excluded
    await inv('3', cust1, 'issued');
    await inv('4', cust2, 'partially_paid', 4000);
    await inv('5', cust3, 'paid', 10000);
    await inv('6', cust3, 'voided');
    await inv('7', cust2, 'issued');
    const nums = (r: { items: Array<{ invoiceNumber: string | null }> }) =>
      r.items.map((i) => i.invoiceNumber).filter((n) => n?.startsWith(P)).sort();

    expect(nums(await deliveries.loadableInvoices({ q: P }))).toEqual([
      `${P}-INV-3`, `${P}-INV-4`, `${P}-INV-7`,
    ]);
    const withPaid = await deliveries.loadableInvoices({ q: P, unpaidOnly: false });
    expect(nums(withPaid)).toEqual([`${P}-INV-3`, `${P}-INV-4`, `${P}-INV-5`, `${P}-INV-7`]);
    expect(withPaid.items.find((i) => i.invoiceNumber === `${P}-INV-5`)?.paid).toBe(true);
    expect(nums(await deliveries.loadableInvoices({ locationId: govId }))).toEqual([`${P}-INV-3`]);
    expect(nums(await deliveries.loadableInvoices({ areaId }))).toEqual([`${P}-INV-3`]);
    expect(nums(await deliveries.loadableInvoices({ q: `${P}-INV-4` }))).toEqual([`${P}-INV-4`]);
    const one = await deliveries.loadableInvoices({ customerId: cust2, pageSize: 1 });
    expect(one.total).toBe(2);
    expect(one.items).toHaveLength(1);
    expect(one.items[0]).toMatchObject({ customer: { id: cust2, customerNumber: `${P}C2` }, totalFils: 10000 });
  });

  it('intake: SENDING at once, idempotent, 409 on a final stop; inbox + outbox written together', async () => {
    const s1 = await stopId('s1');
    const dto = { clientRef: `${P}-ref-1`, stopId: s1, outcome: 'DELIVERED', deliveredAt: '2026-11-07T10:00:00+03:00', signedByName: 'Abu Ali', lat: 31.95, lng: 35.91 } as never;
    expect(await intake.ingest(dto, deliveryRep())).toEqual({ status: 'accepted' });
    expect(await intake.ingest(dto, deliveryRep())).toEqual({ status: 'accepted' });
    const inbox = await q<{ type: string; status: string; result_ref: string; payload: Record<string, unknown> }>(
      `SELECT type, status, result_ref, payload FROM voucher_inbox WHERE client_ref = $1`,
      [`${P}-ref-1`],
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ type: 'DELIVERY', status: 'posted', result_ref: s1 });
    expect(inbox[0].payload).toMatchObject({ erpItemId: `${P}-s1`, runErpId: `${P}-run-1`, outcome: 'DELIVERED' });
    const outbox = await q(`SELECT kind, status FROM erp_outbox WHERE ref = $1`, [`${P}-ref-1`]);
    expect(outbox).toEqual([{ kind: 'DELIVERY_RESULT', status: 'pending' }]);
    expect(pushed).toEqual([`${P}-ref-1`]);

    const stop = (await deliveries.runDetail(await runId())).stops.find((s) => s.id === s1)!;
    expect(stop).toMatchObject({ status: 'LOADED', displayStatus: 'SENDING', signedByName: 'Abu Ali', lat: 31.95 });
    expect(stop.deliveredAt).toBe('2026-11-07T07:00:00.000Z');

    await expect(
      intake.ingest({ ...(dto as object), clientRef: `${P}-ref-2` } as never, deliveryRep()),
    ).rejects.toMatchObject({ status: 409, response: { code: 'STOP_ALREADY_FINAL' } });
    await expect(intake.ingest(dto, { repId: repS } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the pull keeps a SENDING stop the office removed, then settles it when the ERP reports the result', async () => {
    const s1 = await stopId('s1');
    // ERP still LOADED and the office took the stop off: kept, still SENDING.
    await mirror.applyRun(erpRun({ updatedAt: '2026-11-07T09:00:00.000Z', items: [item('s2', '2', `${P}C2`)] }));
    let detail = await deliveries.runDetail(await runId());
    expect(detail.stops.map((s) => s.id)).toContain(s1);
    expect(detail.counts.sending).toBe(1);

    // The ERP took the result (it is back on the run, now DELIVERED under our ref).
    await mirror.applyRun(
      erpRun({
        updatedAt: '2026-11-07T10:01:00.000Z',
        items: [
          item('s1', '1', `${P}C1`, {
            status: 'DELIVERED',
            deliveredAt: '2026-11-07T07:00:00.000Z',
            signedByName: 'Abu Ali',
            resultSource: 'CASHVAN',
            resultExternalRef: `${P}-ref-1`,
          }),
          item('s2', '2', `${P}C2`),
        ],
      }),
    );
    detail = await deliveries.runDetail(await runId());
    const stop = detail.stops.find((s) => s.id === s1)!;
    expect(stop).toMatchObject({ status: 'DELIVERED', displayStatus: 'DELIVERED' });
    expect(detail.counts).toMatchObject({ delivered: 1, loaded: 1, sending: 0 });

    // An ordinary stop removed in the ERP is deleted.
    await mirror.applyRun(erpRun({ updatedAt: '2026-11-07T11:00:00.000Z', items: [detailItem()] }));
    const left = await q(`SELECT s.erp_id FROM delivery_stops s JOIN delivery_runs r ON r.id = s.run_id WHERE r.erp_id = $1`, [`${P}-run-1`]);
    expect(left).toEqual([{ erp_id: `${P}-s1` }]);

    function detailItem() {
      return item('s1', '1', `${P}C1`, { status: 'DELIVERED', deliveredAt: '2026-11-07T07:00:00.000Z', resultExternalRef: `${P}-ref-1` });
    }
  });

  it('collectedFils sums confirmed collections taken against the invoice', async () => {
    await q(
      `INSERT INTO collections (rep_id, customer_id, amount, method, status, erp_invoice_number, note)
       VALUES ($1, $2, 5000, 'cash', 'confirmed', $3, $4), ($1, $2, 700, 'cash', 'pending', $3, $4)`,
      [repD, cust1, `${P}-INV-1`, P],
    );
    const detail = await deliveries.runDetail(await runId());
    expect(detail.stops[0].collectedFils).toBe(5000);
    expect(detail.collectedFils).toBe(5000);
    const byInv = await deliveries.stopByInvoice(`${P}-INV-1`);
    expect(byInv).toMatchObject({
      invoiceNumber: `${P}-INV-1`,
      collectedFils: 5000,
      run: { runNumber: `${P}-DR-1`, status: 'OPEN', rep: { id: repD } },
    });
    await expect(deliveries.stopByInvoice(`${P}-NOPE`)).rejects.toMatchObject({ status: 404 });
  });

  it('the phone: mine has the open run; history the delivered stop; a SALES rep is refused', async () => {
    const mine = await deliveries.mine(deliveryRep());
    expect(mine.runs.map((r) => r.erpId)).toContain(`${P}-run-1`);
    expect(typeof mine.serverTime).toBe('string');

    // Closed: only stops finished in the last 2 days stay on the phone.
    await mirror.applyRun(
      erpRun({
        updatedAt: '2026-11-07T12:00:00.000Z',
        status: 'CLOSED',
        items: [
          item('s1', '1', `${P}C1`, { status: 'DELIVERED', deliveredAt: new Date().toISOString(), resultExternalRef: `${P}-ref-1` }),
          item('s3', '3', `${P}C3`, { status: 'RETURNED', deliveredAt: '2026-10-01T07:00:00.000Z' }),
        ],
      }),
    );
    const after = await deliveries.mine(deliveryRep());
    const closed = after.runs.find((r) => r.erpId === `${P}-run-1`)!;
    expect(closed.status).toBe('CLOSED');
    expect(closed.stops.map((s) => s.invoiceNumber)).toEqual([`${P}-INV-1`]);

    const hist = await deliveries.history(deliveryRep(), {});
    expect(hist.total).toBe(2);
    expect(hist.items[0]).toMatchObject({ invoiceNumber: `${P}-INV-1`, run: { runNumber: `${P}-DR-1` } });
    const returned = await deliveries.history(deliveryRep(), { status: 'RETURNED' });
    expect(returned.items.map((s) => s.invoiceNumber)).toEqual([`${P}-INV-3`]);

    const s1 = await stopId('s1');
    expect((await deliveries.appStop(deliveryRep(), s1)).id).toBe(s1);
    await expect(deliveries.mine({ repId: repS } as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(deliveries.appStop({ repId: repS } as never, s1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('pull: cursor advances; a run the ERP dropped goes, its stops with it', async () => {
    erp.listRunsSince.mockResolvedValueOnce([erpRun({ id: `${P}-run-2`, runNumber: `${P}-DR-2`, updatedAt: '2026-11-08T08:00:00.000Z', items: [] })]);
    expect(await mirror.pullDeliveryRuns()).toBe(1);
    const [c] = await q<{ resume_key: string; last_status: string }>(
      `SELECT resume_key, last_status FROM erp_sync_cursor WHERE entity = 'delivery_runs'`,
    );
    expect(c.resume_key).toBe('2026-11-08T08:00:00.000Z');
    expect(c.last_status).toBe('ok');

    erp.getRun.mockResolvedValueOnce(null);
    expect(await mirror.pullRun(`${P}-run-1`)).toBeNull();
    expect(await q(`SELECT 1 FROM delivery_runs WHERE erp_id = $1`, [`${P}-run-1`])).toEqual([]);
    expect(await q(`SELECT 1 FROM delivery_stops WHERE erp_id LIKE $1`, [`${P}-s%`])).toEqual([]);
  });
});
