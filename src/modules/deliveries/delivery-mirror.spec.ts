import { randomUUID } from 'node:crypto';

import { DeliveryMirrorService, assignChanged, runDay } from './delivery-mirror.service';
import { DeliveryRun } from './entities/delivery-run.entity';
import { DeliveryStop } from './entities/delivery-stop.entity';
import { DeliveryStopLine } from './entities/delivery-stop-line.entity';
import { stopView, runSummaryView } from './delivery-views';
import type { ErpDeliveryRun } from './erp-delivery.types';

/**
 * The delivery mirror (docs/SPEC-delivery-rep.md §5), on an in-memory stand-in
 * for the three tables. The real-DB version is deliveries.integration.spec.ts.
 */

type Row = Record<string, unknown> & { id: string };

/** Equality-only `where`, which is all the mirror asks of a repository. */
class FakeRepo<T extends Row> {
  rows: T[] = [];
  private match(where: Record<string, unknown>) {
    return (r: T) => Object.entries(where).every(([k, v]) => r[k] === v);
  }
  async findOne({ where }: { where: Record<string, unknown> }) {
    return this.rows.find(this.match(where)) ?? null;
  }
  async find({ where }: { where: Record<string, unknown> }) {
    return this.rows.filter(this.match(where));
  }
  create(o: Partial<T>) {
    return { ...o } as T;
  }
  async save(o: T) {
    if (!o.id) (o as Row).id = randomUUID();
    const i = this.rows.findIndex((r) => r.id === o.id);
    if (i >= 0) this.rows[i] = o;
    else this.rows.push(o);
    return o;
  }
  async update(where: Record<string, unknown>, patch: Partial<T>) {
    for (const r of this.rows.filter(this.match(where))) Object.assign(r, patch);
  }
  async delete(arg: { id: string } | string[]) {
    const ids = Array.isArray(arg) ? arg : [arg.id];
    this.rows = this.rows.filter((r) => !ids.includes(r.id));
    // ON DELETE CASCADE, by hand.
    if (this === (db.stops as unknown)) db.lines.rows = db.lines.rows.filter((l) => !ids.includes(l.stopId as string));
  }
}

const db = {
  runs: new FakeRepo<Row>(),
  stops: new FakeRepo<Row>(),
  lines: new FakeRepo<Row>(),
  reps: [] as Array<{ id: string; code: string }>,
  customers: [] as Array<{ id: string; customer_number: string }>,
  idmap: [] as Array<{ erp_id: string; local_id: string }>,
};

function repoFor(entity: unknown) {
  if (entity === DeliveryRun) return db.runs;
  if (entity === DeliveryStop) return db.stops;
  if (entity === DeliveryStopLine) return db.lines;
  throw new Error('unknown entity');
}

const em = {
  getRepository: repoFor,
  query: async (sql: string, params: unknown[]) => {
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (sql.includes('FROM reps')) return db.reps.filter((r) => r.code === params[0]).map((r) => ({ id: r.id }));
    if (sql.includes('FROM erp_id_map')) {
      const m = db.idmap.find((x) => x.erp_id === params[0]);
      return m ? db.customers.filter((c) => c.customer_number === m.local_id).map((c) => ({ id: c.id })) : [];
    }
    if (sql.includes('FROM customers')) {
      return db.customers.filter((c) => c.customer_number === params[0]).map((c) => ({ id: c.id }));
    }
    throw new Error(`unexpected SQL ${sql}`);
  },
};

const events: Array<{ name: string; p: Record<string, unknown> }> = [];
const erp = { getRun: jest.fn(), isEnabled: async () => true, listRunsSince: jest.fn() };
const cursors = {
  row: null as Record<string, unknown> | null,
  findOne: async () => cursors.row,
  create: (o: Record<string, unknown>) => ({ ...o }),
  save: async (o: Record<string, unknown>) => (cursors.row = o),
};
const svc = new DeliveryMirrorService(
  {
    transaction: async (fn: (m: typeof em) => unknown) => fn(em),
    getRepository: repoFor,
  } as never,
  erp as never,
  cursors as never,
  { emit: (name: string, p: Record<string, unknown>) => events.push({ name, p }) } as never,
);

const line = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  lineNo: 1,
  skuCode: 'SKU-1',
  nameAr: 'مياه',
  nameEn: 'Water',
  unit: 'CTN',
  quantity: 10,
  quantityReturned: 0,
  unitPrice: 1.25,
  taxRate: 16,
  lineTotal: 14.5,
  ...over,
});

function erpRun(over: Partial<ErpDeliveryRun> = {}): ErpDeliveryRun {
  return {
    id: 'run-1',
    runNumber: 'DR-0001',
    runDate: '2026-11-07',
    status: 'OPEN',
    notes: null,
    updatedAt: '2026-11-07T08:00:00.000Z',
    openedAt: '2026-11-07T07:00:00.000Z',
    closedAt: null,
    driver: { type: 'SALESMAN', salesmanId: 's1', salesmanCode: 'D01', userId: null, name: 'Driver' },
    vehicle: { id: 'veh-1', name: 'Truck 1', plateNumber: '12-345' },
    items: [
      {
        id: 'item-1',
        sequence: 1,
        status: 'LOADED',
        deliveredAt: null,
        signedByName: null,
        deliveredLat: null,
        deliveredLng: null,
        resultSource: null,
        resultExternalRef: null,
        invoice: {
          id: 'inv-1',
          invoiceNumber: 'INV-1',
          issueDate: '2026-11-06',
          status: 'issued',
          customerId: 'erp-cust-1',
          customerCode: 'C001',
          customerName: 'Shop One',
          customerPhone: '0790000000',
          customerAddress: 'Amman',
          totalAmount: 14.5,
          taxAmount: 2,
          amountPaid: '0.250',
          paymentType: 'CREDIT',
          jofotaraStatus: 'SUBMITTED',
          jofotaraQrCode: 'QR1',
          jofotaraUuid: 'uuid-1',
          lines: [line('ii-1')],
        },
      },
      {
        id: 'item-2',
        sequence: 2,
        status: 'LOADED',
        invoice: {
          id: 'inv-2',
          invoiceNumber: 'INV-2',
          customerId: 'erp-cust-2',
          customerCode: null,
          totalAmount: 3,
          taxAmount: 0,
          amountPaid: 0,
          lines: [line('ii-2', { lineNo: 1, nameAr: null })],
        },
      },
    ],
    ...over,
  };
}

const stopByErp = (erpId: string) => db.stops.rows.find((s) => s.erpId === erpId) as unknown as DeliveryStop;

beforeEach(() => {
  db.runs.rows = [];
  db.stops.rows = [];
  db.lines.rows = [];
  db.reps = [{ id: 'rep-1', code: 'D01' }, { id: 'rep-2', code: 'D02' }];
  db.customers = [
    { id: 'cust-1', customer_number: 'C001' },
    { id: 'cust-2', customer_number: 'ERP-2798694a' },
  ];
  db.idmap = [{ erp_id: 'erp-cust-2', local_id: 'ERP-2798694a' }];
  events.length = 0;
  erp.getRun.mockReset();
  erp.listRunsSince.mockReset();
  cursors.row = null;
});

describe('delivery mirror — apply', () => {
  it('upserts the run, its stops and lines; money in fils; driver code → rep; customer by code or id map', async () => {
    const res = await svc.applyRun(erpRun());
    expect(db.runs.rows).toHaveLength(1);
    const run = db.runs.rows[0] as unknown as DeliveryRun;
    expect(run).toMatchObject({
      erpId: 'run-1',
      runNumber: 'DR-0001',
      repId: 'rep-1',
      driverCode: 'D01',
      vehicleName: 'Truck 1',
      runDate: '2026-11-07',
      status: 'OPEN',
    });
    const s1 = stopByErp('item-1');
    expect(s1).toMatchObject({
      invoiceNumber: 'INV-1',
      customerId: 'cust-1',
      totalFils: '14500',
      taxFils: '2000',
      paidFils: '250',
      jofotaraQr: 'QR1',
      status: 'LOADED',
    });
    // No code on the invoice: found through the ERP id map, like the invoice mirror.
    expect(stopByErp('item-2').customerId).toBe('cust-2');
    const l = db.lines.rows.find((x) => x.erpInvoiceItemId === 'ii-1')!;
    expect(l).toMatchObject({ unitPriceFils: '1250', invoicedQty: '10', taxRate: '16' });
    // The ERP's nameAr is always null; its one name is in nameEn.
    expect(db.lines.rows.find((x) => x.erpInvoiceItemId === 'ii-2')!.nameAr).toBe('Water');
    expect(res.changedStopIds).toHaveLength(2);
    expect(events).toEqual([
      { name: 'delivery.changed', p: expect.objectContaining({ runId: run.id, repId: 'rep-1' }) },
    ]);
  });

  it('a second identical apply changes nothing and signals nothing', async () => {
    await svc.applyRun(erpRun());
    events.length = 0;
    const res = await svc.applyRun(erpRun());
    expect(res.runChanged).toBe(false);
    expect(res.changedStopIds).toEqual([]);
    expect(events).toEqual([]);
    expect(db.stops.rows).toHaveLength(2);
    expect(db.lines.rows).toHaveLength(2);
  });

  it('a driver code that matches no rep leaves the run unassigned', async () => {
    await svc.applyRun(erpRun({ driver: { type: 'USER', salesmanCode: null, name: 'Office' } }));
    expect((db.runs.rows[0] as unknown as DeliveryRun).repId).toBeNull();
  });

  it('a run moved to another rep tells both reps', async () => {
    await svc.applyRun(erpRun());
    events.length = 0;
    await svc.applyRun(
      erpRun({ updatedAt: '2026-11-07T09:00:00.000Z', driver: { salesmanCode: 'D02', name: 'B' } }),
    );
    expect(events[0].p).toMatchObject({ repId: 'rep-2', previousRepId: 'rep-1' });
  });

  it('deletes a stop the ERP removed, with its lines', async () => {
    await svc.applyRun(erpRun());
    const gone = stopByErp('item-2').id;
    const res = await svc.applyRun(
      erpRun({ updatedAt: '2026-11-07T09:00:00.000Z', items: [erpRun().items![0]] }),
    );
    expect(db.stops.rows.map((s) => s.erpId)).toEqual(['item-1']);
    expect(db.lines.rows.some((l) => l.stopId === gone)).toBe(false);
    expect(res.removedStopIds).toEqual([gone]);
  });

  it('keeps a removed stop while a result for it is in flight', async () => {
    await svc.applyRun(erpRun());
    stopByErp('item-2').localResultRef = 'd-1';
    await svc.applyRun(erpRun({ updatedAt: '2026-11-07T09:00:00.000Z', items: [erpRun().items![0]] }));
    expect(db.stops.rows.map((s) => s.erpId).sort()).toEqual(['item-1', 'item-2']);
  });

  it('settles SENDING once the ERP reports the same ref as the item result', async () => {
    await svc.applyRun(erpRun());
    const s = stopByErp('item-1');
    s.localResultRef = 'd-1';
    s.localOutcome = 'DELIVERED';
    s.localDeliveredAt = new Date('2026-11-07T10:00:00Z');
    expect(stopView(s, [], null, 0).displayStatus).toBe('SENDING');
    expect(stopView(s, [], null, 0).deliveredAt).toBe('2026-11-07T10:00:00.000Z');

    // ERP still LOADED (result not arrived yet): stays SENDING.
    await svc.applyRun(erpRun({ updatedAt: '2026-11-07T09:30:00.000Z' }));
    expect(stopByErp('item-1').localResultRef).toBe('d-1');

    const delivered = erpRun({ updatedAt: '2026-11-07T10:01:00.000Z' });
    Object.assign(delivered.items![0], {
      status: 'DELIVERED',
      deliveredAt: '2026-11-07T10:00:00.000Z',
      resultSource: 'CASHVAN',
      resultExternalRef: 'd-1',
    });
    await svc.applyRun(delivered);
    const after = stopByErp('item-1');
    expect(after.localResultRef).toBeNull();
    expect(after.status).toBe('DELIVERED');
    expect(stopView(after, [], null, 0).displayStatus).toBe('DELIVERED');
  });

  it('settledRef clears SENDING even when the ERP names a different ref', async () => {
    await svc.applyRun(erpRun());
    stopByErp('item-1').localResultRef = 'd-1';
    await svc.applyRun(erpRun({ updatedAt: '2026-11-07T09:00:00.000Z' }), { settledRef: 'd-1' });
    expect(stopByErp('item-1').localResultRef).toBeNull();
  });

  it('an older reply never overwrites a newer version', async () => {
    await svc.applyRun(erpRun({ updatedAt: '2026-11-07T10:00:00.000Z', status: 'CLOSED' }));
    await svc.applyRun(erpRun({ updatedAt: '2026-11-07T08:00:00.000Z', status: 'OPEN' }));
    expect((db.runs.rows[0] as unknown as DeliveryRun).status).toBe('CLOSED');
  });

  it('a run the ERP no longer has is dropped by pullRun', async () => {
    await svc.applyRun(erpRun());
    erp.getRun.mockResolvedValue(null);
    expect(await svc.pullRun('run-1')).toBeNull();
    expect(db.runs.rows).toHaveLength(0);
  });
});

describe('delivery mirror — pull cursor', () => {
  it('advances to the newest updatedAt and records the run', async () => {
    erp.listRunsSince.mockResolvedValue([
      erpRun({ id: 'run-1', updatedAt: '2026-11-07T08:00:00.000Z' }),
      erpRun({ id: 'run-2', updatedAt: '2026-11-07T09:00:00.000Z', items: [] }),
    ]);
    expect(await svc.pullDeliveryRuns()).toBe(2);
    expect(cursors.row!.resumeKey).toBe('2026-11-07T09:00:00.000Z');
    expect(cursors.row!.lastStatus).toBe('ok');
    expect(erp.listRunsSince).toHaveBeenCalledWith(undefined);
  });

  it("sends the ERP's updatedAt back exactly as it came (an opaque, local-time cursor)", async () => {
    // Amman wall-clock with a Z, and no milliseconds: re-serialising it through
    // a Date would rewrite it, which is what must never happen.
    cursors.row = { entity: 'delivery_runs', resumeKey: '2026-11-07 12:00:00Z' };
    erp.listRunsSince.mockResolvedValue([erpRun({ id: 'run-1', updatedAt: '2026-11-07T12:30:05Z' })]);
    await svc.pullDeliveryRuns();
    expect(erp.listRunsSince).toHaveBeenCalledWith('2026-11-07 12:00:00Z');
    expect(cursors.row!.resumeKey).toBe('2026-11-07T12:30:05Z');
  });

  it('an empty feed keeps the cursor where it was', async () => {
    cursors.row = { entity: 'delivery_runs', resumeKey: 'opaque-1' };
    erp.listRunsSince.mockResolvedValue([]);
    await svc.pullDeliveryRuns();
    expect(cursors.row!.resumeKey).toBe('opaque-1');
  });

  it('never moves past a run that failed to apply', async () => {
    const bad = erpRun({ id: 'run-bad', updatedAt: '2026-11-07T08:30:00.000Z' });
    Object.defineProperty(bad, 'items', {
      get() {
        throw new Error('boom');
      },
    });
    erp.listRunsSince.mockResolvedValue([
      erpRun({ id: 'run-1', updatedAt: '2026-11-07T08:00:00.000Z' }),
      bad,
      erpRun({ id: 'run-3', updatedAt: '2026-11-07T09:00:00.000Z', items: [] }),
    ]);
    await svc.pullDeliveryRuns();
    expect(cursors.row!.resumeKey).toBe('2026-11-07T08:00:00.000Z');
    expect(cursors.row!.lastStatus).toBe('failed');
  });
});

describe('delivery views', () => {
  it('counts stops by display status and sums collections', () => {
    const base = { returnStatus: 'NONE', totalFils: '0', taxFils: '0', paidFils: '0', sequence: 1 };
    const stops = [
      { ...base, id: 'a', erpId: 'a', status: 'LOADED', localResultRef: null },
      { ...base, id: 'b', erpId: 'b', status: 'LOADED', localResultRef: 'x' },
      { ...base, id: 'c', erpId: 'c', status: 'DELIVERED', localResultRef: null },
      { ...base, id: 'd', erpId: 'd', status: 'RETURNED', localResultRef: null },
    ].map((s, i) => stopView(s as unknown as DeliveryStop, [], null, i * 100));
    const sum = runSummaryView({ id: 'r', erpId: 'e', status: 'OPEN' } as DeliveryRun, stops, null);
    expect(sum.counts).toEqual({ loaded: 1, delivered: 1, partial: 0, returned: 1, sending: 1 });
    expect(sum.stopsTotal).toBe(4);
    expect(sum.collectedFils).toBe(600);
    expect(sum.returns).toEqual({ pending: 0, approved: 0, rejected: 0 });
  });
});

describe('mirror helpers', () => {
  it('assignChanged compares numerics by value and dates by time', () => {
    const t: Record<string, unknown> = { lat: '31.950', at: new Date('2026-01-01T00:00:00Z'), n: '007' };
    expect(assignChanged(t, { lat: '31.95', at: new Date('2026-01-01T00:00:00Z') }, ['lat'])).toBe(false);
    expect(assignChanged(t, { n: '7' })).toBe(true);
    expect(t.n).toBe('7');
  });

  it('runDay keeps a plain date and reads a timestamp in Amman', () => {
    expect(runDay('2026-11-07')).toBe('2026-11-07');
    expect(runDay('2026-11-06T22:30:00.000Z')).toBe('2026-11-07');
    expect(runDay(null)).toBeNull();
  });
});
