import { In } from 'typeorm';

import { SyncService } from './sync.service';

/**
 * The Sync Inbox tabs show every document in that state, not one spelling of it.
 *
 * A credit-limit refusal is stored as `rejected`. The Failed tab asked for
 * `status = 'failed'` and so never listed it — the rep's phone said "the office
 * will fix it" about a document the office could not find.
 */
describe('SyncService.list — inbox filters', () => {
  function makeSvc() {
    const calls: { find: unknown[]; count: unknown[] } = { find: [], count: [] };
    const svc = Object.create(SyncService.prototype) as Record<string, unknown>;
    svc.inbox = {
      findAndCount: async (opts: { where: unknown }) => {
        calls.find.push(opts.where);
        return [[], 0];
      },
      count: async (opts: { where: unknown }) => {
        calls.count.push(opts.where);
        return 0;
      },
    };
    return { svc: svc as unknown as SyncService, calls };
  }

  it('Failed lists rejected and dead-lettered documents too', async () => {
    const { svc, calls } = makeSvc();
    await svc.list({ status: 'failed' });
    expect(calls.find[0]).toEqual({ status: In(['failed', 'rejected', 'dead_letter']) });
  });

  it('Pending lists accepted documents too', async () => {
    const { svc, calls } = makeSvc();
    await svc.list({ status: 'pending' });
    expect(calls.find[0]).toEqual({ status: In(['pending', 'accepted']) });
  });

  it('a specific status still filters to exactly that status', async () => {
    const { svc, calls } = makeSvc();
    await svc.list({ status: 'rejected' });
    expect(calls.find[0]).toEqual({ status: In(['rejected']) });
  });

  it('the failed badge counts every document that needs a person', async () => {
    const { svc, calls } = makeSvc();
    await svc.list({});
    expect(calls.find[0]).toEqual({});
    expect(calls.count).toContainEqual({ status: In(['failed', 'rejected', 'dead_letter']) });
  });
});
