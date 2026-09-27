import { ErpSyncService } from './erp-sync.service';

/**
 * The ERP stock-movement feed loses nothing on the way in.
 *
 * Each case here is a van whose figure used to be short of the ERP's for good:
 *  - the cursor was a createdAt timestamp, and a posting that committed late sat
 *    behind it and was never returned;
 *  - a movement that could not be mirrored was stepped over and the cursor moved on.
 * These pin the seq cursor with its overlap, and the parking of a failed movement
 * until it can land.
 */
describe('pullMovementsForStore — nothing is lost', () => {
  interface Mv {
    id: string;
    seq?: number;
    skuCode: string;
    quantityChanged: number;
    warehouseCode: string;
    createdAt: string;
  }
  interface Cursor {
    entity: string;
    updatedSince?: Date | null;
    seqCursor?: string | null;
  }
  interface Parked {
    erpId: string;
    store: string;
    payload: Mv;
    attempts: number;
    lastError?: string | null;
    firstFailedAt: Date;
    lastTriedAt?: Date;
  }

  const mv = (id: string, seq: number | undefined, sku = 'SKU-1'): Mv => ({
    id,
    seq,
    skuCode: sku,
    quantityChanged: -1,
    warehouseCode: 'VAN-7',
    createdAt: '2026-09-27T08:00:00.000Z',
  });

  function makeSvc(opts: {
    cursor?: Cursor | null;
    feed: Mv[];
    mirrored?: string[];
    parked?: Parked[];
    /** SKUs the catalogue cannot resolve yet. */
    unknownSkus?: string[];
  }) {
    const requests: Record<string, unknown>[] = [];
    const mirroredNow: string[] = [];
    const idmap = new Set(opts.mirrored ?? []);
    const parked = new Map((opts.parked ?? []).map((p) => [p.erpId, p]));
    let savedCursor: Cursor | null = opts.cursor ?? null;

    const svc = Object.create(ErpSyncService.prototype) as Record<string, unknown>;
    svc.logger = { log: () => undefined, warn: () => undefined };
    svc.cursors = {
      findOne: async () => savedCursor,
      create: (c: Cursor) => ({ ...c }),
      save: async (c: Cursor) => {
        savedCursor = { ...c };
        return c;
      },
    };
    svc.erp = {
      list: async (_path: string, params: Record<string, unknown>) => {
        requests.push(params);
        const page = Number(params.page ?? 1);
        return { data: page === 1 ? opts.feed : [] };
      },
    };
    svc.idmap = {
      find: async (q: { where: { erpId: { _value: string[] } } }) =>
        q.where.erpId._value.filter((id) => idmap.has(id)).map((erpId) => ({ erpId })),
      findOne: async (q: { where: { erpId: string } }) => (idmap.has(q.where.erpId) ? {} : null),
    };
    svc.movementRetries = {
      find: async () => [...parked.values()],
      findOne: async (q: { where: { erpId: string } }) => parked.get(q.where.erpId) ?? null,
      create: (p: Partial<Parked>) => ({ attempts: 1, firstFailedAt: new Date(), ...p }),
      save: async (p: Parked) => {
        parked.set(p.erpId, p);
        return p;
      },
      delete: async (q: { erpId: string }) => {
        parked.delete(q.erpId);
      },
    };
    svc.mirrorMovement = async (m: Mv) => {
      if ((opts.unknownSkus ?? []).includes(m.skuCode)) {
        throw new Error(`No cash-van item for ERP SKU "${m.skuCode}"`);
      }
      idmap.add(m.id);
      mirroredNow.push(m.id);
    };

    const run = () =>
      (svc as unknown as { pullMovementsForStore(s: string): Promise<{ count: number; skipped: number }> })
        .pullMovementsForStore('VAN-7');
    return { run, requests, mirroredNow, parked, cursor: () => savedCursor };
  }

  it('reads by seq, starting an overlap behind the cursor', async () => {
    const t = makeSvc({ cursor: { entity: 'movements:VAN-7', seqCursor: '5000' }, feed: [] });
    await t.run();
    expect(t.requests[0].sinceSeq).toBe(3000);
    expect(t.requests[0].since).toBeUndefined();
  });

  it('never goes below seq 0 on a young ledger', async () => {
    const t = makeSvc({ cursor: { entity: 'movements:VAN-7', seqCursor: '12' }, feed: [] });
    await t.run();
    expect(t.requests[0].sinceSeq).toBe(0);
  });

  it('switches over on the first run: old timestamp once, then records the seq it saw', async () => {
    const since = new Date('2026-09-26T00:00:00.000Z');
    const t = makeSvc({
      cursor: { entity: 'movements:VAN-7', updatedSince: since, seqCursor: null },
      feed: [mv('a', 41), mv('b', 42)],
    });
    await t.run();
    expect(t.requests[0].since).toBe(since.toISOString());
    expect(t.requests[0].sinceSeq).toBeUndefined();
    expect(t.cursor()?.seqCursor).toBe('42');
  });

  it('mirrors a late-committing posting that sits behind the cursor', async () => {
    // Cursor at 501; the invoice that took 500 committed after 501 was read.
    const t = makeSvc({
      cursor: { entity: 'movements:VAN-7', seqCursor: '501' },
      feed: [mv('invoice-500', 500), mv('adj-501', 501)],
      mirrored: ['adj-501'],
    });
    const out = await t.run();
    expect(t.mirroredNow).toEqual(['invoice-500']);
    expect(out.count).toBe(1);
  });

  it('does not count a movement twice when the overlap re-reads it', async () => {
    const t = makeSvc({
      cursor: { entity: 'movements:VAN-7', seqCursor: '900' },
      feed: [mv('x', 899), mv('y', 900)],
      mirrored: ['x', 'y'],
    });
    const out = await t.run();
    expect(t.mirroredNow).toEqual([]);
    expect(out.count).toBe(0);
    expect(t.cursor()?.seqCursor).toBe('900');
  });

  it('parks a movement it cannot mirror instead of stepping over it', async () => {
    const t = makeSvc({
      cursor: { entity: 'movements:VAN-7', seqCursor: '10' },
      feed: [mv('unknown', 11, 'SKU-NEW'), mv('ok', 12)],
      unknownSkus: ['SKU-NEW'],
    });
    const out = await t.run();
    expect(t.parked.has('unknown')).toBe(true);
    expect(t.parked.get('unknown')?.payload.skuCode).toBe('SKU-NEW');
    expect(out).toEqual({ count: 1, skipped: 1 });
    // …and one bad row does not hold the rest of the store back.
    expect(t.cursor()?.seqCursor).toBe('12');
  });

  it('lands a parked movement once the catalogue knows its SKU', async () => {
    const t = makeSvc({
      cursor: { entity: 'movements:VAN-7', seqCursor: '99' },
      feed: [],
      parked: [
        { erpId: 'late', store: 'VAN-7', payload: mv('late', 5), attempts: 3, firstFailedAt: new Date() },
      ],
    });
    const out = await t.run();
    expect(t.mirroredNow).toEqual(['late']);
    expect(t.parked.has('late')).toBe(false);
    expect(out.count).toBe(1);
  });

  it('keeps a parked movement that still cannot land, counting the attempt', async () => {
    const t = makeSvc({
      cursor: { entity: 'movements:VAN-7', seqCursor: '99' },
      feed: [],
      parked: [
        { erpId: 'still', store: 'VAN-7', payload: mv('still', 5, 'SKU-NEW'), attempts: 1, firstFailedAt: new Date() },
      ],
      unknownSkus: ['SKU-NEW'],
    });
    await t.run();
    expect(t.parked.get('still')?.attempts).toBe(2);
  });

  it('drops a parked row the overlap already mirrored, without mirroring again', async () => {
    const t = makeSvc({
      cursor: { entity: 'movements:VAN-7', seqCursor: '99' },
      feed: [],
      mirrored: ['dup'],
      parked: [{ erpId: 'dup', store: 'VAN-7', payload: mv('dup', 98), attempts: 1, firstFailedAt: new Date() }],
    });
    await t.run();
    expect(t.mirroredNow).toEqual([]);
    expect(t.parked.has('dup')).toBe(false);
  });

  it('stays on the timestamp cursor against an ERP that sends no seq', async () => {
    const t = makeSvc({
      cursor: { entity: 'movements:VAN-7', updatedSince: new Date('2026-09-26T00:00:00Z') },
      feed: [mv('old-erp', undefined)],
    });
    await t.run();
    expect(t.cursor()?.seqCursor ?? null).toBeNull();
    expect(t.cursor()?.updatedSince?.toISOString()).toBe('2026-09-27T08:00:00.000Z');
  });
});
