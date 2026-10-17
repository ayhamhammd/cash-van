import { ErpOutboxSweepService } from './erp-outbox-sweep.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- hand-built service */

/**
 * A confirmed collection that never got an ERP outbox row is queued by the
 * hourly sweep. It reached the outbox only through an event fired after the
 * commit, and a lost event left the receipt off the ERP for good.
 */
function makeSweep(collectionIds: string[], voucherRows: unknown[] = []) {
  const queries: string[] = [];
  const ds = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      return sql.includes('FROM collections') ? collectionIds.map((id) => ({ id })) : voucherRows;
    }),
  };
  const settings = { getErpConfig: jest.fn().mockResolvedValue({ enabled: true }) };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const svc = new ErpOutboxSweepService(ds as any, settings as any, outbox as any);
  (svc as any).logger = { warn: jest.fn(), log: jest.fn() };
  return { svc, outbox, queries };
}

describe('the outbox sweep and collections', () => {
  it('queues every confirmed collection with no outbox row as a PAYMENT', async () => {
    const { svc, outbox } = makeSweep(['c1', 'c2']);
    const r = await svc.sweep();
    expect(outbox.enqueue).toHaveBeenCalledWith('PAYMENT', 'c1');
    expect(outbox.enqueue).toHaveBeenCalledWith('PAYMENT', 'c2');
    expect(r).toEqual({ found: 2, queued: 2 });
  });

  it('never picks up a receipt that came FROM the ERP', async () => {
    const { svc, queries } = makeSweep([]);
    await svc.sweep();
    const sql = queries.find((q) => q.includes('FROM collections'))!;
    expect(sql).toMatch(/erp_id_map m WHERE m\.entity = 'receipt'/);
    expect(sql).toMatch(/c\.status = 'confirmed'/);
  });

  it('does nothing when the ERP connection is off', async () => {
    const { svc, outbox } = makeSweep(['c1']);
    (svc as any).settings.getErpConfig.mockResolvedValue({ enabled: false });
    expect(await svc.sweep()).toEqual({ found: 0, queued: 0 });
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
