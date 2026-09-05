import { ErpSyncService } from './erp-sync.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- hand-built service, see below */

/**
 * Assign a قائمة أسعار to a customer in the ERP and it must appear, already
 * selected, on that same customer here — without anyone assigning it a second
 * time in the dashboard.
 *
 * Constructor arg order (0-indexed): erp(0), settings(1), dataSource(2),
 * items(3), tobaccoProfiles(4), whs(5), reps(6), customers(7), units(8),
 * itemUnits(9), customerPrices(10), priceLists(11), priceListItems(12),
 * productCategories(13), collections(14), headers(15), txns(16), idmap(17),
 * cursors(18), vouchers(19), outbox(20), outboxRepo(21), events(22).
 */
function makeSvc(opts: { customers: any[]; priceLists: any[] }) {
  const saved: any[] = [];
  const args: any[] = new Array(23).fill(null);
  args[7] = {
    find: jest.fn().mockResolvedValue(opts.customers),
    save: jest.fn(async (c: any) => { saved.push({ ...c }); return c; }),
  };
  args[11] = { find: jest.fn().mockResolvedValue(opts.priceLists) };

  const svc = new (ErpSyncService as any)(...args) as ErpSyncService;
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { svc, saved, customers: opts.customers };
}

const ERP_LIST = { id: 'local-1', erpId: 'erp-pl-1', origin: 'erp', code: 'WHOLESALE' };
const LOCAL_LIST = { id: 'local-2', erpId: null, origin: 'local', code: 'HOUSE' };

const mirror = (svc: ErpSyncService) =>
  (svc as any).mirrorCustomerPriceListAssignments() as Promise<number>;

describe('mirrorCustomerPriceListAssignments', () => {
  it('selects the ERP list on a customer that had none', async () => {
    const cust = { id: 'c1', erpPriceListId: 'erp-pl-1', priceListId: null };
    const { svc, saved } = makeSvc({ customers: [cust], priceLists: [ERP_LIST] });

    await mirror(svc);

    expect(saved).toHaveLength(1);
    expect(saved[0].priceListId).toBe('local-1');
  });

  it('clears the assignment when the ERP takes the list off the customer', async () => {
    // The old mirror skipped this case, so a withdrawn list stayed attached here
    // for ever and the van kept quoting it.
    const cust = { id: 'c1', erpPriceListId: null, priceListId: 'local-1' };
    const { svc, saved } = makeSvc({ customers: [cust], priceLists: [ERP_LIST] });

    await mirror(svc);

    expect(saved).toHaveLength(1);
    expect(saved[0].priceListId).toBeNull();
  });

  it('moves the customer when the ERP changes which list they are on', async () => {
    const other = { id: 'local-3', erpId: 'erp-pl-2', origin: 'erp', code: 'RETAIL' };
    const cust = { id: 'c1', erpPriceListId: 'erp-pl-2', priceListId: 'local-1' };
    const { svc, saved } = makeSvc({ customers: [cust], priceLists: [ERP_LIST, other] });

    await mirror(svc);

    expect(saved[0].priceListId).toBe('local-3');
  });

  it('never overwrites a list the merchant assigned in the dashboard', async () => {
    // The ERP has no API to receive a local assignment back, so overwriting it
    // would destroy work that cannot be recovered upstream.
    const cust = { id: 'c1', erpPriceListId: 'erp-pl-1', priceListId: 'local-2' };
    const { svc, saved } = makeSvc({ customers: [cust], priceLists: [ERP_LIST, LOCAL_LIST] });

    await mirror(svc);

    expect(saved).toHaveLength(0);
  });

  it('leaves the assignment alone when the named list is not mirrored yet', async () => {
    // A half-synced view must not read as "the ERP removed it".
    const cust = { id: 'c1', erpPriceListId: 'erp-pl-missing', priceListId: 'local-1' };
    const { svc, saved } = makeSvc({ customers: [cust], priceLists: [ERP_LIST] });

    await mirror(svc);

    expect(saved).toHaveLength(0);
  });

  it('mirrors an inactive customer too', async () => {
    // These were skipped, so reactivating a customer surfaced whatever list they
    // carried before rather than the one the ERP holds now.
    const cust = { id: 'c1', isActive: false, erpPriceListId: 'erp-pl-1', priceListId: null };
    const { svc, saved } = makeSvc({ customers: [cust], priceLists: [ERP_LIST] });

    await mirror(svc);

    expect(saved[0].priceListId).toBe('local-1');
  });

  it('writes nothing when the assignment already matches', async () => {
    const cust = { id: 'c1', erpPriceListId: 'erp-pl-1', priceListId: 'local-1' };
    const { svc, saved } = makeSvc({ customers: [cust], priceLists: [ERP_LIST] });

    await mirror(svc);

    expect(saved).toHaveLength(0);
  });
});
