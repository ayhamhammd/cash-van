import { ErpSyncService } from './erp-sync.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- hand-built service, see below */

/**
 * customer_price has to FINISH.
 *
 * It resolves every SKU for every customer, one HTTP round trip per page per
 * customer, so at a few thousand customers it never reached the end — it never
 * wrote a cursor, the next run began again at the first customer, and no later
 * customer was ever synced. It showed as "running" with a count of 0 for as long
 * as anyone watched.
 *
 * Constructor arg order (0-indexed): erp(0), settings(1), dataSource(2),
 * items(3), tobaccoProfiles(4), whs(5), reps(6), customers(7), units(8),
 * itemUnits(9), customerPrices(10), priceLists(11), priceListItems(12),
 * productCategories(13), collections(14), headers(15), txns(16), idmap(17),
 * cursors(18), vouchers(19), outbox(20), outboxRepo(21), events(22).
 */
function makeSvc(opts: { customers: string[]; resumeKey?: string | null; perCustomerMs?: number }) {
  const saved: any[] = [];
  const seen: string[] = [];
  const cursorRow: any = { entity: 'customer_price', resumeKey: opts.resumeKey ?? null };

  const args: any[] = new Array(23).fill(null);
  args[7] = {
    find: jest.fn().mockResolvedValue(
      opts.customers.map((n, i) => ({ id: `id-${i}`, customerNumber: n, isActive: true })),
    ),
  };
  args[17] = { findOne: jest.fn().mockResolvedValue(null) }; // idmap: no ERP identity
  args[18] = {
    findOne: jest.fn().mockResolvedValue(cursorRow),
    create: jest.fn((v: any) => ({ ...v })),
    save: jest.fn(async (c: any) => { saved.push({ ...c }); return c; }),
  };

  const svc = new (ErpSyncService as any)(...args) as ErpSyncService;
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  // Stand in for the per-customer ERP round trips, optionally burning clock.
  (svc as any).syncCustomerPricesFor = jest.fn(async (cust: any) => {
    seen.push(cust.customerNumber);
    if (opts.perCustomerMs) jest.advanceTimersByTime(opts.perCustomerMs);
    return 1;
  });
  return { svc, saved, seen };
}

const run = (svc: ErpSyncService) => (svc as any).pullCustomerPrices() as Promise<number>;

describe('pullCustomerPrices', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick'] }));
  afterEach(() => jest.useRealTimers());

  it('clears the resume mark when it reaches the end', async () => {
    const { svc, saved, seen } = makeSvc({ customers: ['C1', 'C2', 'C3'] });

    await run(svc);

    expect(seen).toEqual(['C1', 'C2', 'C3']);
    expect(saved.at(-1).resumeKey).toBeNull();
  });

  it('stops on the budget and records where it got to', async () => {
    // Six minutes per customer: the second one runs, then the budget is spent.
    const { svc, saved, seen } = makeSvc({
      customers: ['C1', 'C2', 'C3'],
      perCustomerMs: 6 * 60 * 1000,
    });

    await run(svc);

    expect(seen).toEqual(['C1']);
    expect(saved.at(-1).resumeKey).toBe('C1');
  });

  it('continues after the recorded customer rather than starting over', async () => {
    const { svc, seen } = makeSvc({ customers: ['C1', 'C2', 'C3'], resumeKey: 'C1' });

    await run(svc);

    expect(seen).toEqual(['C2', 'C3']);
  });

  it('starts from the top when the recorded customer is now last or gone', async () => {
    // A mark left on a customer who has since been deleted must not wedge the
    // entity into doing nothing on every run.
    const { svc, seen } = makeSvc({ customers: ['C1', 'C2'], resumeKey: 'ZZZ' });

    await run(svc);

    expect(seen).toEqual(['C1', 'C2']);
  });

  it('moves past a customer the ERP will not answer for', async () => {
    const { svc, saved, seen } = makeSvc({ customers: ['C1', 'C2'] });
    (svc as any).syncCustomerPricesFor = jest.fn(async (cust: any) => {
      seen.push(cust.customerNumber);
      throw new Error('CUSTOMER_NOT_FOUND');
    });

    await run(svc);

    // Both attempted, and the run still completed and cleared the mark — a
    // permanently failing customer must not block everyone behind them.
    expect(seen).toEqual(['C1', 'C2']);
    expect(saved.at(-1).resumeKey).toBeNull();
  });
});
