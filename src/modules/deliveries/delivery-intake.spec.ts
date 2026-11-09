import { ConflictException, ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { LoadableInvoicesQuery, SyncDeliveryDto } from './dto/deliveries.dto';
import {
  DeliveryIntakeService,
  buildResultCall,
  isTerminalResultRefusal,
  stopIsFinal,
  type DeliveryInboxPayload,
} from './delivery-intake.service';

const STOP = '11111111-1111-4111-8111-111111111111';

async function errorsOf(body: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(SyncDeliveryDto, body, { enableImplicitConversion: true });
  const errs = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errs.map((e) => e.property);
}

const valid = {
  clientRef: 'd-1',
  stopId: STOP,
  outcome: 'DELIVERED',
  deliveredAt: '2026-11-08T10:42:00+03:00',
  signedByName: 'أبو محمد',
  lat: 31.95,
  lng: 35.91,
};

describe('sync/deliveries — validation', () => {
  it('accepts a whole-invoice result', async () => {
    expect(await errorsOf(valid)).toEqual([]);
    expect(await errorsOf({ ...valid, outcome: 'RETURNED', signedByName: undefined })).toEqual([]);
  });

  it('needs a clientRef, a stop uuid and a delivery time', async () => {
    expect(await errorsOf({ ...valid, clientRef: undefined })).toContain('clientRef');
    expect(await errorsOf({ ...valid, clientRef: '' })).toContain('clientRef');
    expect(await errorsOf({ ...valid, stopId: 'stop-1' })).toContain('stopId');
    expect(await errorsOf({ ...valid, deliveredAt: 'yesterday' })).toContain('deliveredAt');
  });

  it('takes PARTIAL with lines and proofRefs (phase 2), and nothing outside the three outcomes', async () => {
    const lines = [{ erpInvoiceItemId: 'ii-1', deliveredQty: 8.5, reasonCode: 'DAMAGED', note: 'wet' }];
    expect(await errorsOf({ ...valid, outcome: 'PARTIAL', lines, proofRefs: ['p-1', 's-1'] })).toEqual([]);
    expect(await errorsOf({ ...valid, outcome: 'LOST' })).toContain('outcome');
  });

  it('refuses a line with a negative quantity or an unknown reason', async () => {
    expect(
      await errorsOf({ ...valid, lines: [{ erpInvoiceItemId: 'ii-1', deliveredQty: -1 }] }),
    ).toContain('lines');
    expect(
      await errorsOf({ ...valid, lines: [{ erpInvoiceItemId: 'ii-1', deliveredQty: 1, reasonCode: 'BROKEN' }] }),
    ).toContain('lines');
  });

  it('refuses a position off the globe and unknown fields', async () => {
    expect(await errorsOf({ ...valid, lat: 91 })).toContain('lat');
    expect(await errorsOf({ ...valid, lng: -181 })).toContain('lng');
    expect(await errorsOf({ ...valid, sellExtra: [] })).toContain('sellExtra');
  });
});

describe('loadable-invoices — unpaidOnly', () => {
  const read = (v: unknown) =>
    plainToInstance(LoadableInvoicesQuery, { unpaidOnly: v }, { enableImplicitConversion: true }).unpaidOnly;
  it("reads 'false' as false, not as a truthy string", () => {
    expect(read('false')).toBe(false);
    expect(read('0')).toBe(false);
    expect(read('true')).toBe(true);
    expect(read(undefined)).toBeUndefined();
  });
});

describe('DELIVERY_RESULT — the ERP call', () => {
  const payload: DeliveryInboxPayload = {
    clientRef: 'd-7f3',
    stopId: STOP,
    erpItemId: 'item-9',
    runErpId: 'run-1',
    outcome: 'DELIVERED',
    deliveredAt: '2026-11-08T07:42:00.000Z',
    signedByName: 'Abu Mohammad',
    lat: 31.95,
    lng: 35.91,
    note: null,
  };

  it('posts to the item result route with externalId = clientRef as the idempotency key', () => {
    expect(buildResultCall(payload)).toEqual({
      path: 'delivery-runs/items/item-9/result',
      idem: 'd-7f3',
      body: {
        externalId: 'd-7f3',
        outcome: 'DELIVERED',
        deliveredAt: '2026-11-08T07:42:00.000Z',
        signedByName: 'Abu Mohammad',
        lat: 31.95,
        lng: 35.91,
      },
    });
  });

  it('leaves out what the phone did not send', () => {
    const call = buildResultCall({ ...payload, outcome: 'RETURNED', signedByName: null, lat: null, lng: null });
    expect(call.body).toEqual({
      externalId: 'd-7f3',
      outcome: 'RETURNED',
      deliveredAt: '2026-11-08T07:42:00.000Z',
    });
  });

  it('is terminal on 409 STOP_ALREADY_FINAL / RUN_CLOSED only', () => {
    expect(isTerminalResultRefusal(409, { error: { code: 'STOP_ALREADY_FINAL' } })).toBe(true);
    expect(isTerminalResultRefusal(409, { code: 'RUN_CLOSED' })).toBe(true);
    expect(isTerminalResultRefusal(409, { error: { code: 'SOMETHING_ELSE' } })).toBe(false);
    expect(isTerminalResultRefusal(422, { error: { code: 'STOP_ALREADY_FINAL' } })).toBe(false);
    expect(isTerminalResultRefusal(503, null)).toBe(false);
  });
});

describe('sync/deliveries — intake', () => {
  type Stop = {
    id: string;
    runId: string;
    erpId: string;
    status: string;
    localResultRef: string | null;
    resultExternalRef: string | null;
  };

  /** One stop, one inbox, one outbox — enough to see what the intake writes. */
  type Line = { erpInvoiceItemId: string; invoicedQty: string; localDeliveredQty?: string | null };
  type Proof = { clientRef: string; stopId: string; kind: 'PHOTO' | 'SIGNATURE' };

  /** One stop, its lines and proofs, one inbox, one outbox — enough to see what the intake writes. */
  function world(
    stop: Stop | null,
    inbox: Array<{ client_ref: string; type: string }> = [],
    opts: {
      lines?: Line[];
      proofs?: Proof[];
      proofRequired?: boolean;
      increaseOn?: boolean;
      products?: Array<{
        id: string;
        item_number: string;
        name_ar: string;
        name_en: string | null;
        unit: string;
        unit_name_ar: string | null;
        unit_name_en: string | null;
      }>;
    } = {},
  ) {
    const increases: unknown[][] = [];
    const outbox: string[] = [];
    const updates: Array<Record<string, unknown>> = [];
    const lines = opts.lines ?? [];
    const proofs = opts.proofs ?? [];
    const em = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('SELECT type FROM voucher_inbox')) {
          return inbox.filter((r) => r.client_ref === params[0]);
        }
        if (sql.includes('FROM delivery_stops WHERE id = $1 FOR UPDATE')) {
          return stop && stop.id === params[0] ? [{ id: stop.id }] : [];
        }
        if (sql.includes('delivery_increase_requests AS')) return [{ on: opts.increaseOn ?? false }];
        if (sql.includes('FROM app_settings')) return [{ required: opts.proofRequired ?? false }];
        if (sql.includes('FROM item_cart')) {
          const ids = params[0] as string[];
          return (opts.products ?? []).filter((p) => ids.includes(p.id));
        }
        if (sql.includes('INSERT INTO delivery_increase_requests')) {
          increases.push(params);
          return [];
        }
        if (sql.includes('INSERT INTO voucher_inbox')) {
          if (inbox.some((r) => r.client_ref === params[0])) return [];
          inbox.push({ client_ref: params[0] as string, type: 'DELIVERY', payload: JSON.parse(params[3] as string) } as never);
          return [{ id: 'inbox-1' }];
        }
        if (sql.includes('INSERT INTO erp_outbox')) {
          outbox.push(`${params[0]}:${params[1]}`);
          return [];
        }
        throw new Error(`unexpected SQL ${sql}`);
      },
      getRepository: (entity: { name: string }) => ({
        findOneByOrFail: async () => stop,
        findOneBy: async () => ({ id: 'run-local', erpId: 'run-1', repId: 'rep-1' }),
        find: async ({ where }: { where: unknown }) => {
          if (entity.name === 'DeliveryStopLine') return lines;
          if (entity.name === 'DeliveryProof') {
            const ws = where as Array<{ clientRef: string; stopId: string }>;
            return proofs.filter((p) => ws.some((w) => w.clientRef === p.clientRef && w.stopId === p.stopId));
          }
          return [];
        },
        update: async (w: Record<string, unknown>, patch: Record<string, unknown>) => {
          if (entity.name === 'DeliveryStop' && stop) Object.assign(stop, patch);
          if (entity.name === 'DeliveryStopLine') {
            const l = lines.find((x) => x.erpInvoiceItemId === w.erpInvoiceItemId);
            if (l) Object.assign(l, patch);
          }
          updates.push(patch);
        },
      }),
    };
    const signals: unknown[] = [];
    const pushed: string[] = [];
    const notified: Array<Record<string, unknown>> = [];
    const svc = new DeliveryIntakeService(
      { transaction: async (fn: (m: typeof em) => unknown) => fn(em) } as never,
      {
        requireDeliveryRep: async (u: { repId?: string }) => {
          if (u.repId !== 'rep-1') throw new ForbiddenException();
          return { id: 'rep-1', code: 'D01', kind: 'DELIVERY' };
        },
      } as never,
      { signal: (r: unknown) => signals.push(r) } as never,
      { pushRefNow: async (ref: string) => void pushed.push(ref), registerHandler: () => undefined } as never,
      { notifyManagers: async (n: Record<string, unknown>) => void notified.push(n) } as never,
      {} as never,
    );
    return { svc, outbox, updates, signals, pushed, inbox, lines, notified, increases };
  }

  const actor = { repId: 'rep-1' } as never;
  const dto = (over: Record<string, unknown> = {}) =>
    ({ clientRef: 'd-1', stopId: STOP, outcome: 'DELIVERED', deliveredAt: '2026-11-08T10:42:00+03:00', ...over }) as never;
  const loaded = (): Stop => ({
    id: STOP,
    runId: 'run-local',
    erpId: 'item-9',
    status: 'LOADED',
    localResultRef: null,
    resultExternalRef: null,
  });

  it('writes the local result, enqueues DELIVERY_RESULT and signals', async () => {
    const stop = loaded();
    const w = world(stop);
    expect(await w.svc.ingest(dto(), actor)).toEqual({ status: 'accepted' });
    expect(stop.localResultRef).toBe('d-1');
    expect(w.updates[0]).toMatchObject({ localOutcome: 'DELIVERED', localResultRef: 'd-1' });
    expect(w.outbox).toEqual(['DELIVERY_RESULT:d-1']);
    expect(w.signals).toHaveLength(1);
    expect(w.pushed).toEqual(['d-1']);
  });

  it('is idempotent on clientRef: the same ref again changes nothing', async () => {
    const stop = loaded();
    const w = world(stop);
    await w.svc.ingest(dto(), actor);
    expect(await w.svc.ingest(dto(), actor)).toEqual({ status: 'accepted' });
    expect(w.outbox).toEqual(['DELIVERY_RESULT:d-1']);
    expect(w.signals).toHaveLength(1);
  });

  it('409 STOP_ALREADY_FINAL when another result is in flight', async () => {
    const w = world({ ...loaded(), localResultRef: 'd-other' });
    await expect(w.svc.ingest(dto(), actor)).rejects.toBeInstanceOf(ConflictException);
    await expect(w.svc.ingest(dto(), actor)).rejects.toMatchObject({
      response: { code: 'STOP_ALREADY_FINAL' },
    });
    expect(w.outbox).toEqual([]);
  });

  it('409 STOP_ALREADY_FINAL when the ERP already has a result under another ref', async () => {
    const w = world({ ...loaded(), status: 'DELIVERED', resultExternalRef: 'erp-desk' });
    await expect(w.svc.ingest(dto(), actor)).rejects.toMatchObject({
      response: { code: 'STOP_ALREADY_FINAL' },
    });
  });

  it('accepts the same ref the ERP already recorded (a lost reply re-sent)', async () => {
    const w = world({ ...loaded(), status: 'DELIVERED', resultExternalRef: 'd-1' });
    expect(await w.svc.ingest(dto(), actor)).toEqual({ status: 'accepted' });
  });

  it('rejects an unknown stop in the body, not with an error', async () => {
    const w = world(null);
    expect(await w.svc.ingest(dto(), actor)).toEqual({ status: 'rejected', reason: 'STOP_NOT_FOUND' });
  });

  it('rejects a clientRef already used by another kind of document', async () => {
    const w = world(loaded(), [{ client_ref: 'd-1', type: 'VOUCHER' }]);
    expect(await w.svc.ingest(dto(), actor)).toEqual({ status: 'rejected', reason: 'CLIENT_REF_IN_USE' });
  });

  it('403 for a rep who is not a delivery rep', async () => {
    const w = world(loaded());
    await expect(w.svc.ingest(dto(), { repId: 'sales-rep' } as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  describe('phase 2 — lines and proofs', () => {
    const lines = (): Line[] => [
      { erpInvoiceItemId: 'ii-1', invoicedQty: '10' },
      { erpInvoiceItemId: 'ii-2', invoicedQty: '4' },
    ];
    const proofs: Proof[] = [
      { clientRef: 'p-1', stopId: STOP, kind: 'PHOTO' },
      { clientRef: 's-1', stopId: STOP, kind: 'SIGNATURE' },
      { clientRef: 'p-other', stopId: 'another-stop', kind: 'PHOTO' },
    ];
    const partial = (over: Record<string, unknown> = {}) =>
      dto({
        outcome: 'PARTIAL',
        lines: [{ erpInvoiceItemId: 'ii-1', deliveredQty: 7, reasonCode: 'DAMAGED', note: 'wet' }],
        proofRefs: ['p-1', 's-1'],
        ...over,
      });

    it('writes every line locally, enqueues proofs before the result, and asks managers to approve', async () => {
      const stop = loaded();
      const w = world(stop, [], { lines: lines(), proofs, proofRequired: true });
      expect(await w.svc.ingest(partial(), actor)).toEqual({ status: 'accepted' });
      expect(stop).toMatchObject({ localResultRef: 'd-1', localOutcome: 'PARTIAL' });
      expect(w.lines).toEqual([
        expect.objectContaining({ erpInvoiceItemId: 'ii-1', localDeliveredQty: '7', localReasonCode: 'DAMAGED', localNote: 'wet' }),
        expect.objectContaining({ erpInvoiceItemId: 'ii-2', localDeliveredQty: '4', localReasonCode: null }),
      ]);
      expect(w.outbox).toEqual(['DELIVERY_PROOF:p-1', 'DELIVERY_PROOF:s-1', 'DELIVERY_RESULT:d-1']);
      const payload = (w.inbox.find((r) => r.client_ref === 'd-1') as unknown as { payload: Record<string, unknown> }).payload;
      expect(payload).toMatchObject({
        outcome: 'PARTIAL',
        proofRefs: ['p-1', 's-1'],
        differingLines: 1,
        lines: [{ invoiceItemId: 'ii-1', deliveredQty: 7, reasonCode: 'DAMAGED', note: 'wet' }],
      });
      expect(w.notified).toEqual([
        expect.objectContaining({ kind: 'delivery.return_requested', refType: 'delivery_stop', refId: STOP }),
      ]);
      expect(String(w.notified[0].bodyEn)).toMatch(/1 line$/);
      expect(String(w.notified[0].bodyAr)).toMatch(/، بند واحد$/);
      await new Promise((r) => setImmediate(r));
      expect(w.pushed).toEqual(['p-1', 's-1', 'd-1']);
    });

    it('a full delivery notifies nobody', async () => {
      const w = world(loaded(), [], { lines: lines(), proofs, proofRequired: true });
      expect(await w.svc.ingest(dto({ proofRefs: ['p-1', 's-1'] }), actor)).toEqual({ status: 'accepted' });
      expect(w.notified).toEqual([]);
    });

    it.each([
      ['OUTCOME_MISMATCH', { outcome: 'DELIVERED' }],
      ['QTY_OUT_OF_RANGE', { lines: [{ erpInvoiceItemId: 'ii-1', deliveredQty: 11 }] }],
      ['REASON_REQUIRED', { lines: [{ erpInvoiceItemId: 'ii-1', deliveredQty: 7 }] }],
      ['NOTE_REQUIRED', { lines: [{ erpInvoiceItemId: 'ii-1', deliveredQty: 7, reasonCode: 'OTHER' }] }],
      ['LINE_UNKNOWN', { lines: [{ erpInvoiceItemId: 'nope', deliveredQty: 1 }] }],
      ['PROOF_MISSING', { proofRefs: ['p-1'] }],
      ['PROOF_UNKNOWN', { proofRefs: ['p-1', 's-1', 'p-other'] }],
    ])('rejects %s in the body, and writes nothing', async (reason, over) => {
      const stop = loaded();
      const w = world(stop, [], { lines: lines(), proofs, proofRequired: true });
      expect(await w.svc.ingest(partial(over), actor)).toEqual({ status: 'rejected', reason });
      expect(stop.localResultRef).toBeNull();
      expect(w.outbox).toEqual([]);
      expect(w.inbox).toEqual([]);
    });

    it('RETURNED needs a photo only; with proofs switched off, none', async () => {
      const w = world(loaded(), [], { lines: lines(), proofs, proofRequired: true });
      expect(await w.svc.ingest(dto({ outcome: 'RETURNED', proofRefs: ['p-1'] }), actor)).toEqual({
        status: 'accepted',
      });
      expect(w.lines.map((l) => l.localDeliveredQty)).toEqual(['0', '0']);
      expect(w.notified).toHaveLength(1);
      const off = world(loaded(), [], { lines: lines(), proofs, proofRequired: false });
      expect(await off.svc.ingest(dto(), actor)).toEqual({ status: 'accepted' });
    });
  });

  describe('phase 4 — increase requests', () => {
    const P1 = '22222222-2222-4222-8222-222222222222';
    const P2 = '33333333-3333-4333-8333-333333333333';
    // The BASE unit (unit_of_measure → units), never item_cart.unit.
    const products = [
      { id: P1, item_number: 'W1', name_ar: 'ماء', name_en: 'Water', unit: 'PCE', unit_name_ar: 'قطعة', unit_name_en: 'piece' },
      // No units row for KG here: the code stands in for the names.
      { id: P2, item_number: 'J1', name_ar: 'عصير', name_en: null, unit: 'KG', unit_name_ar: null, unit_name_en: null },
    ];
    const payloadOf = (w: ReturnType<typeof world>) =>
      (w.inbox.find((r) => r.client_ref === 'd-1') as unknown as { payload: Record<string, unknown> }).payload;

    it('switch off: the increase is ignored, the delivery still goes through', async () => {
      const w = world(loaded(), [], { increaseOn: false, products });
      expect(await w.svc.ingest(dto({ increase: [{ productId: P1, qty: 2 }] }), actor)).toEqual({ status: 'accepted' });
      expect(w.increases).toEqual([]);
      expect(payloadOf(w)).not.toHaveProperty('increase');
      expect(w.notified).toEqual([]);
    });

    it('switch on: the request is stored with names snapshotted, sent to the ERP, and the managers told', async () => {
      const w = world(loaded(), [], { increaseOn: true, products });
      const out = await w.svc.ingest(
        dto({ increase: [{ productId: P1, qty: 2 }, { productId: P2, qty: 1.5 }, { productId: P1, qty: 1 }] }),
        actor,
      );
      expect(out).toEqual({ status: 'accepted' });
      expect(w.increases).toHaveLength(1);
      const [clientRef, stopId, runId, , repId, , linesJson] = w.increases[0] as string[];
      expect([clientRef, stopId, runId, repId]).toEqual(['d-1', STOP, 'run-local', 'rep-1']);
      // The same product twice is one line.
      expect(JSON.parse(linesJson)).toEqual([
        { productId: P1, skuCode: 'W1', nameAr: 'ماء', nameEn: 'Water', unit: 'PCE', unitNameAr: 'قطعة', unitNameEn: 'piece', qty: 3 },
        { productId: P2, skuCode: 'J1', nameAr: 'عصير', nameEn: null, unit: 'KG', unitNameAr: 'KG', unitNameEn: 'KG', qty: 1.5 },
      ]);
      expect(payloadOf(w).increase).toEqual([
        { skuCode: 'W1', qty: 3 },
        { skuCode: 'J1', qty: 1.5 },
      ]);
      expect(w.notified).toEqual([
        expect.objectContaining({
          kind: 'delivery.increase_requested',
          bodyAr: expect.stringMatching(/، صنفان$/),
          bodyEn: expect.stringMatching(/^Increase request: invoice .*, 2 items$/),
        }),
      ]);
    });

    it('a refused stop may still carry one', async () => {
      const w = world(loaded(), [], { increaseOn: true, products });
      expect(
        await w.svc.ingest(dto({ outcome: 'RETURNED', increase: [{ productId: P2, qty: 4 }] }), actor),
      ).toEqual({ status: 'accepted' });
      expect(w.increases).toHaveLength(1);
    });

    it('an unknown or inactive product rejects the result, and nothing is written', async () => {
      const stop = loaded();
      const w = world(stop, [], { increaseOn: true, products });
      expect(
        await w.svc.ingest(dto({ increase: [{ productId: '44444444-4444-4444-8444-444444444444', qty: 1 }] }), actor),
      ).toEqual({ status: 'rejected', reason: 'INCREASE_UNKNOWN_PRODUCT' });
      expect(w.increases).toEqual([]);
      expect(stop.localResultRef).toBeNull();
    });

    it('the replayed result makes no second request', async () => {
      const w = world(loaded(), [], { increaseOn: true, products });
      await w.svc.ingest(dto({ increase: [{ productId: P1, qty: 1 }] }), actor);
      await w.svc.ingest(dto({ increase: [{ productId: P1, qty: 1 }] }), actor);
      expect(w.increases).toHaveLength(1);
      expect(w.notified).toHaveLength(1);
    });

    it('the body: qty > 0 and at most 30 lines', async () => {
      expect(await errorsOf({ ...valid, increase: [{ productId: P1, qty: 0.5 }] })).toEqual([]);
      expect(await errorsOf({ ...valid, increase: [{ productId: P1, qty: 0 }] })).toContain('increase');
      expect(await errorsOf({ ...valid, increase: [{ productId: 'nope', qty: 1 }] })).toContain('increase');
      const many = Array.from({ length: 31 }, () => ({ productId: P1, qty: 1 }));
      expect(await errorsOf({ ...valid, increase: many })).toContain('increase');
    });

    it('the ERP call carries increase as [{ skuCode, qty }]', () => {
      const call = buildResultCall({
        clientRef: 'd-1',
        stopId: STOP,
        erpItemId: 'item-9',
        runErpId: 'run-1',
        outcome: 'DELIVERED',
        deliveredAt: '2026-11-08T07:00:00.000Z',
        increase: [{ skuCode: 'W1', qty: 3 }],
      });
      expect(call.body.increase).toEqual([{ skuCode: 'W1', qty: 3 }]);
    });
  });

  it('a stop is final once it has an ERP result or one in flight', () => {
    expect(stopIsFinal({ status: 'LOADED', localResultRef: null })).toBe(false);
    expect(stopIsFinal({ status: 'LOADED', localResultRef: 'x' })).toBe(true);
    expect(stopIsFinal({ status: 'RETURNED', localResultRef: null })).toBe(true);
  });
});
