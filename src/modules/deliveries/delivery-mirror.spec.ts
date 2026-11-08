import { randomUUID } from 'node:crypto';

import { DeliveryMirrorService, assignChanged, runDay } from './delivery-mirror.service';
import { DeliveryRun } from './entities/delivery-run.entity';
import { DeliveryStop } from './entities/delivery-stop.entity';
import { DeliveryStopLine } from './entities/delivery-stop-line.entity';
import { goodsBack, stopView, runSummaryView } from './delivery-views';
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
  proofs: [] as Array<{ stop_id: string; erp_attachment_id: string }>,
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
    if (sql.includes('FROM delivery_proofs')) {
      const ids = params[1] as string[];
      return db.proofs.filter((p) => p.stop_id === params[0] && ids.includes(p.erp_attachment_id));
    }
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
const notices: Array<{ userId: string; n: Record<string, unknown> }> = [];
const svc = new DeliveryMirrorService(
  {
    transaction: async (fn: (m: typeof em) => unknown) => fn(em),
    getRepository: repoFor,
    query: async (sql: string, params: unknown[]) =>
      sql.includes('SELECT user_id FROM reps')
        ? db.reps.filter((r) => r.id === params[0]).map((r) => ({ user_id: `user-of-${r.id}` }))
        : [],
  } as never,
  erp as never,
  cursors as never,
  { emit: (name: string, p: Record<string, unknown>) => events.push({ name, p }) } as never,
  { notifyUser: async (userId: string, n: Record<string, unknown>) => void notices.push({ userId, n }) } as never,
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
  db.proofs = [];
  events.length = 0;
  notices.length = 0;
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

describe('delivery mirror — phase 2 results', () => {
  const lineOf = (stopErp: string, itemId: string) =>
    db.lines.rows.find((l) => l.stopId === stopByErp(stopErp).id && l.erpInvoiceItemId === itemId)!;

  it('invoiced is the quantity less what was already returned', async () => {
    const r = erpRun();
    r.items![0].invoice!.lines = [line('ii-1', { quantity: 10, quantityReturned: 3 })];
    await svc.applyRun(r);
    expect(lineOf('item-1', 'ii-1').invoicedQty).toBe('7');
    // Still LOADED: no result side at all.
    expect(lineOf('item-1', 'ii-1').deliveredQty).toBeNull();
  });

  it('PARTIAL: a listed line takes the ERP result; an unlisted one was delivered in full; returnStatus PENDING', async () => {
    const r = erpRun({ updatedAt: '2026-11-07T10:00:00.000Z' });
    r.items![0].invoice!.lines = [line('ii-1'), line('ii-1b', { lineNo: 2, quantity: 4 })];
    Object.assign(r.items![0], {
      status: 'PARTIAL',
      returnStatus: 'PENDING',
      results: [
        { invoiceItemId: 'ii-1', invoicedQty: 10, deliveredQty: 7, reasonCode: 'DAMAGED', condition: 'DAMAGED', note: 'wet', approvedQty: null },
      ],
    });
    await svc.applyRun(r);
    expect(stopByErp('item-1')).toMatchObject({ status: 'PARTIAL', returnStatus: 'PENDING' });
    expect(lineOf('item-1', 'ii-1')).toMatchObject({ deliveredQty: '7', reasonCode: 'DAMAGED', condition: 'DAMAGED', note: 'wet' });
    expect(lineOf('item-1', 'ii-1b')).toMatchObject({ deliveredQty: '4', reasonCode: null, condition: null });
  });

  it('the condition comes from the reason when the ERP leaves it out', async () => {
    const r = erpRun();
    Object.assign(r.items![0], {
      status: 'PARTIAL',
      results: [{ invoiceItemId: 'ii-1', deliveredQty: 9, reasonCode: 'WRONG_ITEM' }],
    });
    await svc.applyRun(r);
    expect(lineOf('item-1', 'ii-1').condition).toBe('GOOD');
  });

  it('RETURNED with no line rows delivered nothing', async () => {
    const r = erpRun();
    Object.assign(r.items![0], { status: 'RETURNED', returnStatus: 'PENDING', results: [] });
    await svc.applyRun(r);
    expect(lineOf('item-1', 'ii-1').deliveredQty).toBe('0');
    expect(stopByErp('item-1').returnStatus).toBe('PENDING');
  });

  it('an unknown returnStatus reads as NONE', async () => {
    const r = erpRun();
    Object.assign(r.items![0], { returnStatus: 'WHATEVER' });
    await svc.applyRun(r);
    expect(stopByErp('item-1').returnStatus).toBe('NONE');
  });

  it('counts ERP attachments that are not one of our proofs, without mirroring them', async () => {
    await svc.applyRun(erpRun());
    db.proofs = [{ stop_id: stopByErp('item-1').id, erp_attachment_id: 'att-ours' }];
    const r = erpRun({ updatedAt: '2026-11-07T11:00:00.000Z' });
    r.items![0].attachments = [{ id: 'att-ours', role: 'PHOTO' }, { id: 'att-erp', role: 'PHOTO' }];
    await svc.applyRun(r);
    expect(stopByErp('item-1').erpOnlyAttachments).toBe(1);
  });
});

describe('delivery mirror — phase 3 decisions', () => {
  const pendingRun = (over: Partial<ErpDeliveryRun> = {}) => {
    const r = erpRun(over);
    Object.assign(r.items![0], {
      status: 'PARTIAL',
      returnStatus: 'PENDING',
      results: [{ invoiceItemId: 'ii-1', invoicedQty: 10, deliveredQty: 6, reasonCode: 'DAMAGED', condition: 'DAMAGED', approvedQty: null }],
    });
    return r;
  };
  const approved = (updatedAt: string) => {
    const r = pendingRun({ updatedAt });
    Object.assign(r.items![0], {
      returnStatus: 'APPROVED',
      returnDecidedAt: '2026-11-08T09:00:00.000Z',
      returnDecidedBy: { id: 'u-9', name: 'Office Admin' },
      returnDecisionNote: 'ok',
      results: [{ invoiceItemId: 'ii-1', invoicedQty: 10, deliveredQty: 6, reasonCode: 'DAMAGED', condition: 'DAMAGED', approvedQty: 3 }],
      creditNote: { id: 'cn-1', number: 'CN-0007', total: 3.48, taxTotal: 0.48, jofotara: { status: 'SUBMITTED', qrCode: 'CNQR', uuid: 'cn-uuid' } },
    });
    // The credit note raised the line's quantityReturned on the invoice.
    r.items![0].invoice!.lines = [line('ii-1', { quantityReturned: 3 })];
    return r;
  };

  it('mirrors the decision and the credit note, and tells the rep once', async () => {
    await svc.applyRun(pendingRun());
    events.length = 0;
    await svc.applyRun(approved('2026-11-08T09:00:01.000Z'));
    const s = stopByErp('item-1');
    expect(s).toMatchObject({
      returnStatus: 'APPROVED',
      returnDecidedBy: 'Office Admin',
      returnDecisionNote: 'ok',
      creditNoteErpId: 'cn-1',
      creditNoteNumber: 'CN-0007',
      creditNoteTotalFils: '3480',
      creditNoteTaxFils: '480',
      creditNoteQr: 'CNQR',
      creditNoteJofotaraStatus: 'SUBMITTED',
      creditNoteUuid: 'cn-uuid',
    });
    expect(s.returnDecidedAt).toEqual(new Date('2026-11-08T09:00:00.000Z'));
    const l = db.lines.rows.find((x) => x.stopId === s.id && x.erpInvoiceItemId === 'ii-1')!;
    // Frozen at the result: the credit note's quantityReturned does not shrink it.
    expect(l).toMatchObject({ approvedQty: '3', invoicedQty: '10', deliveredQty: '6', billedQty: '10', lineTotalFils: '14500' });
    expect(notices).toEqual([
      {
        userId: 'user-of-rep-1',
        n: expect.objectContaining({
          kind: 'delivery.return_approved',
          bodyEn: 'Return for invoice INV-1 approved (credit note CN-0007)',
          refType: 'delivery_stop',
          refId: s.id,
        }),
      },
    ]);
    expect(events[0].p).toMatchObject({ repId: 'rep-1', reason: 'delivery.return.decided' });

    // Seen again by the next pull: no second notification.
    await svc.applyRun(approved('2026-11-08T09:05:00.000Z'));
    expect(notices).toHaveLength(1);
  });

  it('the invoiced quantity is frozen once the stop has a result, even without results[].invoicedQty', async () => {
    const r1 = pendingRun();
    r1.items![0].results = [{ invoiceItemId: 'ii-1', deliveredQty: 6, reasonCode: 'DAMAGED' }];
    await svc.applyRun(r1);
    const r2 = approved('2026-11-08T09:00:01.000Z');
    r2.items![0].results = [{ invoiceItemId: 'ii-1', deliveredQty: 6, reasonCode: 'DAMAGED', approvedQty: 4 }];
    r2.items![0].invoice!.lines = [line('ii-1', { quantityReturned: 4 })];
    await svc.applyRun(r2);
    const l = db.lines.rows.find((x) => x.stopId === stopByErp('item-1').id)!;
    expect(l).toMatchObject({ invoicedQty: '10', deliveredQty: '6', approvedQty: '4' });
  });

  it('a rejection tells the rep with the office note', async () => {
    await svc.applyRun(pendingRun());
    const r = pendingRun({ updatedAt: '2026-11-08T09:00:00.000Z' });
    Object.assign(r.items![0], { returnStatus: 'REJECTED', returnDecidedBy: 'Finance', returnDecisionNote: 'customer took it' });
    await svc.applyRun(r);
    expect(stopByErp('item-1')).toMatchObject({ returnStatus: 'REJECTED', returnDecidedBy: 'Finance', creditNoteNumber: null });
    expect(notices[0].n).toMatchObject({
      kind: 'delivery.return_rejected',
      bodyEn: 'Return for invoice INV-1 rejected: customer took it',
      bodyAr: 'رُفض مرتجع الفاتورة INV-1: customer took it',
    });
  });

  it('a stop first seen already decided notifies nobody', async () => {
    await svc.applyRun(approved('2026-11-08T09:00:01.000Z'));
    expect(stopByErp('item-1').returnStatus).toBe('APPROVED');
    expect(notices).toEqual([]);
  });

  it('a decision on a run with no rep is mirrored and notifies nobody', async () => {
    await svc.applyRun(pendingRun({ driver: { salesmanCode: 'NOBODY' } }));
    await svc.applyRun({ ...approved('2026-11-08T09:00:01.000Z'), driver: { salesmanCode: 'NOBODY' } });
    expect(stopByErp('item-1').returnStatus).toBe('APPROVED');
    expect(notices).toEqual([]);
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

describe('delivery views — phase 2', () => {
  const stop = (over: Record<string, unknown>) =>
    ({
      id: 'st-1',
      erpId: 'e',
      sequence: 1,
      status: 'LOADED',
      returnStatus: 'NONE',
      totalFils: '0',
      taxFils: '0',
      paidFils: '0',
      localResultRef: null,
      erpOnlyAttachments: 0,
      ...over,
    }) as unknown as DeliveryStop;
  const ln = (over: Record<string, unknown>) =>
    ({
      id: 'l',
      erpInvoiceItemId: 'ii',
      lineNo: 1,
      skuCode: 'W1',
      nameAr: 'ماء',
      nameEn: 'Water',
      unit: 'CTN',
      invoicedQty: '10',
      unitPriceFils: '1000',
      taxRate: '16',
      ...over,
    }) as unknown as DeliveryStopLine;

  it('while SENDING the phone\'s line figures show, and the stop is waiting for approval', () => {
    const v = stopView(
      stop({ localResultRef: 'd-1' }),
      [ln({ deliveredQty: null, localDeliveredQty: '7', localReasonCode: 'EXPIRED', localNote: 'old' })],
      null,
      0,
    );
    expect(v.displayStatus).toBe('SENDING');
    expect(v.returnStatus).toBe('PENDING');
    expect(v.lines[0]).toMatchObject({ deliveredQty: 7, reasonCode: 'EXPIRED', condition: 'DAMAGED', note: 'old' });
  });

  it('once settled the ERP figures show', () => {
    const v = stopView(
      stop({ status: 'PARTIAL', returnStatus: 'PENDING' }),
      [ln({ deliveredQty: '8', reasonCode: 'DAMAGED', condition: 'DAMAGED', localDeliveredQty: '7' })],
      null,
      0,
    );
    expect(v.lines[0]).toMatchObject({ deliveredQty: 8, reasonCode: 'DAMAGED', condition: 'DAMAGED' });
  });

  it('proofs carry the url of the route that may stream them, photos first', () => {
    const proofs = [
      { id: 'pr-s', stopId: 'st-1', kind: 'SIGNATURE', mime: 'image/png', sizeBytes: 900, capturedAt: null, createdAt: new Date(1) },
      { id: 'pr-p', stopId: 'st-1', kind: 'PHOTO', mime: 'image/jpeg', sizeBytes: 9000, capturedAt: new Date('2026-11-08T07:00:00Z'), createdAt: new Date(2) },
    ] as never;
    const dash = stopView(stop({}), [], null, 0, proofs, 'dashboard');
    expect(dash.proofs.map((p) => p.kind)).toEqual(['PHOTO', 'SIGNATURE']);
    expect(dash.proofs[0]).toEqual({
      id: 'pr-p',
      kind: 'PHOTO',
      mime: 'image/jpeg',
      sizeBytes: 9000,
      capturedAt: '2026-11-08T07:00:00.000Z',
      url: '/api/v1/deliveries/stops/st-1/proofs/pr-p',
    });
    expect(stopView(stop({}), [], null, 0, proofs, 'phone').proofs[0].url).toBe(
      '/api/v1/deliveries/my-stops/st-1/proofs/pr-p',
    );
  });

  it('goodsBack sums invoiced − delivered by item over finished stops only', () => {
    const views = [
      stopView(stop({ id: 'a', status: 'PARTIAL' }), [ln({ deliveredQty: '7' }), ln({ id: 'l2', skuCode: 'J1', nameEn: 'Juice', deliveredQty: '10' })], null, 0),
      stopView(stop({ id: 'b', status: 'RETURNED' }), [ln({ deliveredQty: '0', invoicedQty: '2.5' })], null, 0),
      stopView(stop({ id: 'c', status: 'LOADED' }), [ln({ deliveredQty: null })], null, 0),
    ];
    expect(goodsBack(views)).toEqual([{ skuCode: 'W1', nameAr: 'ماء', nameEn: 'Water', unit: 'CTN', qty: 5.5 }]);
    const sum = runSummaryView({ id: 'r', erpId: 'e', status: 'OPEN' } as DeliveryRun, views, null);
    expect(sum.counts).toMatchObject({ partial: 1, returned: 1, loaded: 1 });
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
