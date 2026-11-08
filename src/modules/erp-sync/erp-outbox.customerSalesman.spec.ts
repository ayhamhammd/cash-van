import { ErpOutboxService } from './erp-outbox.service';
import type { ErpOutbox } from './entities/erp-outbox.entity';

describe('ErpOutboxService — a customer’s salesman reaches the ERP', () => {
  interface Internals {
    pushOne(row: ErpOutbox): Promise<void>;
    pushSalesmen(rows: ErpOutbox[]): Promise<void>;
  }

  interface Found {
    customer_number: string;
    erp_id: string | null;
    erp_code?: string | null;
    rep_id: string | null;
    rep_code: string | null;
    rep_name?: string | null;
  }

  function makeSvc(opts: {
    found: Found[];
    reply?: (body: { assignments: Array<{ customerCode: string; salesmanCode: string | null }> }) => unknown;
    freshUpdatedAt?: Date;
  }) {
    const svc = Object.create(ErpOutboxService.prototype) as Record<string, unknown>;
    const posts: Array<{ path: string; body: { assignments: Array<{ customerCode: string; salesmanCode: string | null }> } }> = [];
    svc.logger = { log: () => undefined, warn: () => undefined };
    svc.outbox = {
      save: async (r: ErpOutbox) => r,
      query: async () => opts.found,
      findOne: async () => ({ updatedAt: opts.freshUpdatedAt ?? new Date(1000) }),
    };
    svc.erp = {
      post: async (path: string, body: { assignments: Array<{ customerCode: string; salesmanCode: string | null }> }) => {
        posts.push({ path, body });
        return opts.reply
          ? opts.reply(body)
          : {
              ok: true,
              status: 200,
              data: { success: true, data: { received: body.assignments.length, failed: 0, problems: [] } },
            };
      },
      patchResult: async () => {
        throw new Error('a salesman push must not PATCH');
      },
    };
    return { svc: svc as unknown as Internals, posts };
  }

  let seq = 0;
  const row = (ref: string) =>
    ({
      id: `o-${++seq}`,
      kind: 'CUSTOMER_SALESMAN',
      ref,
      status: 'pending',
      attempts: 0,
      updatedAt: new Date(1000),
    }) as ErpOutbox;

  const mapped = (ref: string, repCode: string | null): Found => ({
    customer_number: ref,
    erp_id: `erp-${ref}`,
    rep_id: repCode ? `rep-${repCode}` : null,
    rep_code: repCode,
  });

  it('sends many customers in one assign-salesmen call and marks each sent', async () => {
    const { svc, posts } = makeSvc({ found: [mapped('C1', '204'), mapped('C2', '106')] });
    const rows = [row('C1'), row('C2')];
    await svc.pushSalesmen(rows);
    expect(posts).toEqual([
      {
        path: 'customers/assign-salesmen',
        body: {
          assignments: [
            { customerCode: 'C1', salesmanCode: '204' },
            { customerCode: 'C2', salesmanCode: '106' },
          ],
        },
      },
    ]);
    expect(rows.map((r) => r.status)).toEqual(['posted', 'posted']);
  });

  it('splits a large move into calls of 50', async () => {
    const refs = Array.from({ length: 120 }, (_, i) => `C${i}`);
    const { svc, posts } = makeSvc({ found: refs.map((r) => mapped(r, '204')) });
    const rows = refs.map(row);
    await svc.pushSalesmen(rows);
    expect(posts.map((p) => p.body.assignments.length)).toEqual([50, 50, 20]);
    expect(rows.every((r) => r.status === 'posted')).toBe(true);
  });

  it('a retried single row goes the same way', async () => {
    const { svc, posts } = makeSvc({ found: [mapped('C1', '204')] });
    const r = row('C1');
    await svc.pushOne(r);
    expect(posts).toHaveLength(1);
    expect(r.status).toBe('posted');
  });

  it('puts an ERP refusal back on that customer only', async () => {
    const { svc } = makeSvc({
      found: [mapped('C1', '204'), mapped('C2', '999')],
      reply: () => ({
        ok: true,
        status: 200,
        data: {
          success: true,
          data: { failed: 1, problems: [{ customerCode: 'C2', problem: 'Salesman code "999" was not found.' }] },
        },
      }),
    });
    const [a, b] = [row('C1'), row('C2')];
    await svc.pushSalesmen([a, b]);
    expect(a.status).toBe('posted');
    expect(b.status).toBe('pending');
    expect(b.attempts).toBe(1);
    expect(b.error).toContain('999');
  });

  it('waits while the customer has not reached the ERP yet', async () => {
    const { svc, posts } = makeSvc({ found: [{ customer_number: 'C1', erp_id: null, rep_id: 'r', rep_code: '204' }] });
    const r = row('C1');
    await svc.pushSalesmen([r]);
    expect(posts).toHaveLength(0);
    expect(r.status).toBe('pending');
  });

  it('clears the salesman in the ERP when the customer has none, in a call of its own', async () => {
    const { svc, posts } = makeSvc({ found: [mapped('C1', null), mapped('C2', '204')] });
    const [a, b] = [row('C1'), row('C2')];
    await svc.pushSalesmen([a, b]);
    expect(posts.map((p) => p.body.assignments)).toEqual([
      [{ customerCode: 'C2', salesmanCode: '204' }],
      [{ customerCode: 'C1', salesmanCode: null }],
    ]);
    expect([a.status, b.status]).toEqual(['posted', 'posted']);
  });

  it('an ERP too old to clear refuses only the clears, which say to update it', async () => {
    const { svc } = makeSvc({
      found: [mapped('C1', null), mapped('C2', '204')],
      reply: (body) =>
        body.assignments.some((x) => x.salesmanCode === null)
          ? { ok: false, status: 400, data: null, error: 'Validation failed.' }
          : { ok: true, status: 200, data: { success: true, data: { failed: 0, problems: [] } } },
    });
    const [a, b] = [row('C1'), row('C2')];
    await svc.pushSalesmen([a, b]);
    expect(b.status).toBe('posted');
    expect(a.status).toBe('dead_letter');
    expect(a.error).toContain('Update the ERP');
  });

  it('dead-letters a salesman without a code, and a customer that is gone', async () => {
    const { svc } = makeSvc({
      found: [{ customer_number: 'C1', erp_id: 'e', rep_id: 'r', rep_code: null, rep_name: 'احمد' }],
    });
    const [a, b] = [row('C1'), row('GONE')];
    await svc.pushSalesmen([a, b]);
    expect(a.status).toBe('dead_letter');
    expect(a.error).toContain('احمد');
    expect(b.status).toBe('dead_letter');
  });

  it('stays queued when the salesman changed again while it was being sent', async () => {
    const { svc } = makeSvc({ found: [mapped('C1', '204')], freshUpdatedAt: new Date(5000) });
    const r = row('C1');
    await svc.pushSalesmen([r]);
    expect(r.status).toBe('pending');
  });

  it('backs off without spending an attempt when rate limited, and retries an ERP outage', async () => {
    let status = 429;
    const { svc } = makeSvc({
      found: [mapped('C1', '204')],
      reply: () => ({ ok: false, status, data: null, error: 'RATE_LIMITED' }),
    });
    const r = row('C1');
    await svc.pushSalesmen([r]);
    expect(r.status).toBe('pending');
    expect(r.attempts).toBe(0);
    status = 503;
    for (let i = 0; i < 8; i++) await svc.pushSalesmen([r]);
    expect(r.status).toBe('pending');
  });
});
