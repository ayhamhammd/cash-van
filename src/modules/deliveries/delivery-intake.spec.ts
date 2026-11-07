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

  it('refuses PARTIAL in phase 1 (no line results yet)', async () => {
    expect(await errorsOf({ ...valid, outcome: 'PARTIAL' })).toContain('outcome');
  });

  it('refuses a position off the globe and unknown fields', async () => {
    expect(await errorsOf({ ...valid, lat: 91 })).toContain('lat');
    expect(await errorsOf({ ...valid, lng: -181 })).toContain('lng');
    expect(await errorsOf({ ...valid, lines: [] })).toContain('lines');
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
  function world(stop: Stop | null, inbox: Array<{ client_ref: string; type: string }> = []) {
    const outbox: string[] = [];
    const updates: Array<Record<string, unknown>> = [];
    const em = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('SELECT type FROM voucher_inbox')) {
          return inbox.filter((r) => r.client_ref === params[0]);
        }
        if (sql.includes('FROM delivery_stops WHERE id = $1 FOR UPDATE')) {
          return stop && stop.id === params[0] ? [{ id: stop.id }] : [];
        }
        if (sql.includes('INSERT INTO voucher_inbox')) {
          if (inbox.some((r) => r.client_ref === params[0])) return [];
          inbox.push({ client_ref: params[0] as string, type: 'DELIVERY' });
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
        update: async (_w: unknown, patch: Record<string, unknown>) => {
          if (entity.name === 'DeliveryStop' && stop) Object.assign(stop, patch);
          updates.push(patch);
        },
      }),
    };
    const signals: unknown[] = [];
    const pushed: string[] = [];
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
    );
    return { svc, outbox, updates, signals, pushed, inbox };
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

  it('a stop is final once it has an ERP result or one in flight', () => {
    expect(stopIsFinal({ status: 'LOADED', localResultRef: null })).toBe(false);
    expect(stopIsFinal({ status: 'LOADED', localResultRef: 'x' })).toBe(true);
    expect(stopIsFinal({ status: 'RETURNED', localResultRef: null })).toBe(true);
  });
});
