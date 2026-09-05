import { ErpSyncService } from './erp-sync.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- hand-built service, see below */

/**
 * Making the local customer list match the ERP's.
 *
 * The unattended sync cannot do this: pruneVanished only sees customers that are
 * in the id map, and refuses outright when half or more of them would go. Both
 * guards are right for something that runs every five minutes unwatched — which
 * is why the bulk cleanup is asked for by hand and reports before it acts.
 *
 * Constructor arg order (0-indexed): erp(0), settings(1), dataSource(2),
 * items(3), tobaccoProfiles(4), whs(5), reps(6), customers(7), units(8),
 * itemUnits(9), customerPrices(10), priceLists(11), priceListItems(12),
 * productCategories(13), collections(14), headers(15), txns(16), idmap(17),
 * cursors(18), vouchers(19), outbox(20), outboxRepo(21), events(22).
 */
function makeSvc(opts: {
  erp: any[];
  locals: any[];
  maps?: any[];
  voucherCustomerNumbers?: string[];
}) {
  const softDeleted: string[] = [];
  const args: any[] = new Array(23).fill(null);

  args[0] = {
    list: jest.fn().mockResolvedValue({ data: opts.erp, total: opts.erp.length }),
  };
  args[1] = { getErpConfig: jest.fn().mockResolvedValue({ enabled: true, baseUrl: 'x', apiKey: 'y' }) };
  args[7] = {
    find: jest.fn().mockResolvedValue(opts.locals),
    softDelete: jest.fn(async ({ id }: any) => { softDeleted.push(id); }),
  };
  args[14] = { find: jest.fn().mockResolvedValue([]) };
  args[15] = {
    find: jest.fn().mockResolvedValue(
      (opts.voucherCustomerNumbers ?? []).map((n) => ({ customerNumber: n })),
    ),
  };
  args[17] = { find: jest.fn().mockResolvedValue(opts.maps ?? []) };

  const svc = new (ErpSyncService as any)(...args) as ErpSyncService;
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { svc, softDeleted };
}

const L = (num: string, name = '') => ({ id: `id-${num}`, customerNumber: num, customerName: name });

describe('reconcileCustomers', () => {
  it('reports the gap without changing anything', async () => {
    const { svc, softDeleted } = makeSvc({
      erp: [{ id: 'e1', code: 'C1', name: 'A' }],
      locals: [L('C1'), L('C2'), L('C3')],
    });

    const r = await svc.reconcileCustomers();

    expect(r.applied).toBe(false);
    expect(r.matched).toBe(1);
    expect(r.onlyLocally).toBe(2);
    expect(softDeleted).toHaveLength(0);
  });

  it('archives the strangers once confirmed', async () => {
    const { svc, softDeleted } = makeSvc({
      erp: [{ id: 'e1', code: 'C1', name: 'A' }],
      locals: [L('C1'), L('C2'), L('C3')],
    });

    const r = await svc.reconcileCustomers({ apply: true });

    expect(r.archived).toBe(2);
    expect(softDeleted).toEqual(['id-C2', 'id-C3']);
  });

  it('leaves a customer that has traded alone by default', async () => {
    // Archiving one silently is how a salesman loses a shop that owes them money.
    const { svc, softDeleted } = makeSvc({
      erp: [{ id: 'e1', code: 'C1', name: 'A' }],
      locals: [L('C1'), L('C2'), L('C3')],
      voucherCustomerNumbers: ['C2'],
    });

    const r = await svc.reconcileCustomers({ apply: true });

    expect(r.onlyLocallyWithHistory).toBe(1);
    expect(r.archived).toBe(1);
    expect(softDeleted).toEqual(['id-C3']);
  });

  it('archives a traded customer only when explicitly told to', async () => {
    const { svc, softDeleted } = makeSvc({
      erp: [{ id: 'e1', code: 'C1', name: 'A' }],
      locals: [L('C1'), L('C2')],
      voucherCustomerNumbers: ['C2'],
    });

    await svc.reconcileCustomers({ apply: true, includeWithHistory: true });

    expect(softDeleted).toEqual(['id-C2']);
  });

  it('matches on the ERP id when the local number is not the ERP code', async () => {
    // Customers created in the ERP UI have a null code and are held locally as
    // ERP-<id>; matching on code alone would call every one of them a stranger.
    const { svc, softDeleted } = makeSvc({
      erp: [{ id: 'e9', code: null, name: 'A' }],
      locals: [L('ERP-e9')],
      maps: [{ entity: 'customer', localId: 'ERP-e9', erpId: 'e9' }],
    });

    const r = await svc.reconcileCustomers({ apply: true });

    expect(r.matched).toBe(1);
    expect(softDeleted).toHaveLength(0);
  });

  it('refuses to reconcile against an empty ERP list', async () => {
    // Otherwise one bad response archives every customer the client has.
    const { svc } = makeSvc({ erp: [], locals: [L('C1')] });
    await expect(svc.reconcileCustomers({ apply: true })).rejects.toThrow(/no customers/i);
  });
});
