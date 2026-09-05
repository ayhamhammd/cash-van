import { ErpSyncService } from './erp-sync.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- hand-built service, see below */

/**
 * Renaming a salesman in the ERP must reach the salesman here, not just their store.
 *
 * The rep's name was written once at provision and never again, so a rename in
 * the ERP moved `warehouses.wh_name` and left `reps.name_ar` on the old name —
 * which is the name the mobile app, the notifications and the outbound voucher
 * payload all read.
 *
 * Constructor arg order (0-indexed): erp(0), settings(1), dataSource(2),
 * items(3), tobaccoProfiles(4), whs(5), reps(6), customers(7), units(8),
 * itemUnits(9), customerPrices(10), priceLists(11), priceListItems(12),
 * productCategories(13), collections(14), headers(15), txns(16), idmap(17),
 * cursors(18), vouchers(19), outbox(20), outboxRepo(21), events(22).
 */
function makeSvc(opts: {
  warehouses: any[];
  rep: any | null;
  user?: any | null;
}) {
  const savedReps: any[] = [];
  const savedUsers: any[] = [];

  const args: any[] = new Array(23).fill(null);
  args[0] = { list: jest.fn().mockResolvedValue({ data: opts.warehouses, total: opts.warehouses.length }) };
  args[1] = { salesmanActivationEnabled: jest.fn().mockResolvedValue(false) };
  args[2] = {
    transaction: jest.fn(),
    getRepository: jest.fn().mockReturnValue({
      findOne: jest.fn().mockResolvedValue(opts.user ?? null),
      save: jest.fn(async (u: any) => { savedUsers.push({ ...u }); return u; }),
    }),
  };
  args[5] = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((v: any) => ({ ...v })),
    save: jest.fn(async (w: any) => w),
    softDelete: jest.fn(),
  };
  args[6] = {
    findOne: jest.fn().mockResolvedValue(opts.rep),
    save: jest.fn(async (r: any) => { savedReps.push({ ...r }); return r; }),
  };
  // Empty id-map: pruneVanished finds nothing mapped and prunes nothing.
  args[17] = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((v: any) => ({ ...v })),
    save: jest.fn(async (m: any) => m),
  };

  const svc = new (ErpSyncService as any)(...args) as ErpSyncService;
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { svc, savedReps, savedUsers, dataSource: args[2] };
}

const VAN = { id: 'erp-wh-1', code: 'S012', name: 'محمد الجديد', isVan: true, isMain: false };

describe('pullWarehouses — salesman rename', () => {
  it('writes the ERP name onto an existing rep', async () => {
    const { svc, savedReps } = makeSvc({
      warehouses: [VAN],
      rep: { id: 'rep-1', code: 'S012', nameAr: 'محمد القديم', userId: null },
    });

    await (svc as any).pullWarehouses();

    expect(savedReps).toHaveLength(1);
    expect(savedReps[0].nameAr).toBe('محمد الجديد');
  });

  it('renames the login user that was auto-provisioned from the salesman code', async () => {
    const { svc, savedUsers } = makeSvc({
      warehouses: [VAN],
      rep: { id: 'rep-1', code: 'S012', nameAr: 'محمد القديم', userId: 'user-1' },
      user: { id: 'user-1', userNumber: 'S012', name: 'محمد القديم', nameAr: 'محمد القديم' },
    });

    await (svc as any).pullWarehouses();

    expect(savedUsers).toHaveLength(1);
    expect(savedUsers[0].name).toBe('محمد الجديد');
    expect(savedUsers[0].nameAr).toBe('محمد الجديد');
  });

  it('leaves a hand-linked user alone — they are a person with their own name', async () => {
    const { svc, savedReps, savedUsers } = makeSvc({
      warehouses: [VAN],
      rep: { id: 'rep-1', code: 'S012', nameAr: 'محمد القديم', userId: 'user-9' },
      user: { id: 'user-9', userNumber: 'ADMIN-2', name: 'سامي', nameAr: 'سامي' },
    });

    await (svc as any).pullWarehouses();

    expect(savedReps[0].nameAr).toBe('محمد الجديد');
    expect(savedUsers).toHaveLength(0);
  });

  it('does not touch the rep when the name is unchanged', async () => {
    const { svc, savedReps } = makeSvc({
      warehouses: [VAN],
      rep: { id: 'rep-1', code: 'S012', nameAr: 'محمد الجديد', userId: 'user-1' },
    });

    await (svc as any).pullWarehouses();

    expect(savedReps).toHaveLength(0);
  });

  it('provisions rather than renames when no rep exists yet', async () => {
    const { svc, savedReps, dataSource } = makeSvc({ warehouses: [VAN], rep: null });

    await (svc as any).pullWarehouses();

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(savedReps).toHaveLength(0);
  });
});
