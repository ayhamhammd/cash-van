import { DataSource } from 'typeorm';

import { ErpOutboxService } from './erp-outbox.service';
import type { ErpOutbox } from './entities/erp-outbox.entity';
import { requeueOutboxLatestWithin } from './outbox-enqueue';

describe('ErpOutboxService — a customer area becomes the ERP address', () => {
  interface Internals {
    buildCalls(row: ErpOutbox): Promise<Array<Record<string, unknown>> | null>;
    pushOne(row: ErpOutbox): Promise<void>;
  }

  function makeSvc(opts: {
    erpId?: string | null;
    area?: string | null;
    customerExists?: boolean;
    patch?: () => Promise<unknown>;
    freshUpdatedAt?: Date;
  }) {
    const svc = Object.create(ErpOutboxService.prototype) as Record<string, unknown>;
    const patched: Array<{ path: string; body: unknown }> = [];
    svc.logger = { log: () => undefined, warn: () => undefined };
    svc.idmap = {
      findOne: async () => (opts.erpId ? { erpId: opts.erpId } : null),
    };
    svc.outbox = {
      save: async (r: ErpOutbox) => r,
      query: async () => (opts.customerExists === false ? [] : [{ area: opts.area ?? null }]),
      findOne: async () => ({ updatedAt: opts.freshUpdatedAt ?? new Date(1000) }),
    };
    svc.erp = {
      post: async () => {
        throw new Error('an area update must not POST');
      },
      patchResult: async (path: string, body: unknown) => {
        patched.push({ path, body });
        return opts.patch ? opts.patch() : { ok: true, status: 200, data: {} };
      },
    };
    return { svc: svc as unknown as Internals, patched };
  }

  const row = () =>
    ({
      id: 'o-1',
      kind: 'CUSTOMER_AREA',
      ref: 'CUST-000001',
      status: 'pending',
      attempts: 0,
      updatedAt: new Date(1000),
    }) as ErpOutbox;

  it('patches the mapped ERP customer with the area name', async () => {
    const { svc } = makeSvc({ erpId: 'erp-uuid', area: 'الزرقاء' });
    const calls = await svc.buildCalls(row());
    expect(calls).toEqual([
      { path: 'customers/erp-uuid', body: { address: 'الزرقاء' }, method: 'PATCH' },
    ]);
  });

  it('clears the address when the customer has no area', async () => {
    const { svc } = makeSvc({ erpId: 'erp-uuid', area: null });
    const calls = await svc.buildCalls(row());
    expect(calls?.[0].body).toEqual({ address: null });
  });

  it('waits while the customer has not reached the ERP yet', async () => {
    const { svc } = makeSvc({ erpId: null, area: 'الزرقاء' });
    expect(await svc.buildCalls(row())).toBeNull();
    const r = row();
    await svc.pushOne(r);
    expect(r.status).toBe('pending');
  });

  it('sends it as a PATCH and marks it sent', async () => {
    const { svc, patched } = makeSvc({ erpId: 'erp-uuid', area: 'الرصيفة' });
    const r = row();
    await svc.pushOne(r);
    expect(patched).toEqual([{ path: 'customers/erp-uuid', body: { address: 'الرصيفة' } }]);
    expect(r.status).toBe('posted');
  });

  it('stays queued when the area changed again while it was being sent', async () => {
    const { svc } = makeSvc({ erpId: 'erp-uuid', area: 'الرصيفة', freshUpdatedAt: new Date(5000) });
    const r = row();
    await svc.pushOne(r);
    expect(r.status).toBe('pending');
  });

  it('dead-letters a customer that no longer exists', async () => {
    const { svc } = makeSvc({ erpId: 'erp-uuid', customerExists: false });
    const r = row();
    await svc.pushOne(r);
    expect(r.status).toBe('dead_letter');
  });
});

const HAS_DB = Boolean(process.env.DB_NAME);
(HAS_DB ? describe : describe.skip)('requeueOutboxLatestWithin (real DB)', () => {
  let ds: DataSource;
  const REF = 'ZZAREA-CUST-1';

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'cashvan',
      database: process.env.DB_NAME as string,
      synchronize: false,
    });
    await ds.initialize();
    await ds.query(`DELETE FROM erp_outbox WHERE ref = $1`, [REF]);
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DELETE FROM erp_outbox WHERE ref = $1`, [REF]);
    await ds.destroy();
  });

  it('sends a customer whose area changed after it was already sent', async () => {
    await requeueOutboxLatestWithin(ds.manager, 'CUSTOMER_AREA', REF);
    await ds.query(
      `UPDATE erp_outbox SET status = 'posted', attempts = 1, error = 'x' WHERE kind = 'CUSTOMER_AREA' AND ref = $1`,
      [REF],
    );

    await requeueOutboxLatestWithin(ds.manager, 'CUSTOMER_AREA', REF);

    const rows = await ds.query(
      `SELECT status, attempts, error FROM erp_outbox WHERE kind = 'CUSTOMER_AREA' AND ref = $1`,
      [REF],
    );
    expect(rows).toEqual([{ status: 'pending', attempts: 0, error: null }]);
  });
});
