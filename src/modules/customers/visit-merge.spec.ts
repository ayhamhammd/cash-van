import { CustomersService } from './customers.service';

/**
 * A rep's day at one customer produces up to three reports: the app on entry,
 * the app on leave, and the voucher itself. They are one call, so the day's row
 * is merged rather than appended.
 *
 * Getting this wrong is quiet and expensive — the same stop lands in both the
 * "sold" and "did not sell" columns, and every rep looks twice as busy as they
 * are. Nobody reports that as a bug; they just stop trusting the report.
 */
describe('CustomersService.recordVisit — merge rules', () => {
  const CUSTOMER = 'c1';
  const REP = 'r1';

  function build(existing: Record<string, unknown> | null) {
    const saved: Array<Record<string, unknown>> = [];
    const repo = {
      createQueryBuilder: () => ({
        setLock: () => ({
          where: () => ({
            andWhere: () => ({
              andWhere: () => ({ getOne: async () => existing }),
            }),
          }),
        }),
      }),
      create: (v: Record<string, unknown>) => ({ ...v }),
      save: async (v: Record<string, unknown>) => {
        saved.push(v);
        return v;
      },
    };
    const service = Object.create(CustomersService.prototype) as CustomersService;
    (service as unknown as { visits: unknown }).visits = {
      manager: { transaction: async (fn: (em: unknown) => unknown) => fn({ getRepository: () => repo }) },
    };
    return { service, saved };
  }

  it('creates the day’s first call as a plain visit', async () => {
    const { service } = build(null);
    const row = await service.recordVisit({
      customerId: CUSTOMER,
      repId: REP,
      hadSale: false,
      visitedAt: new Date('2026-08-02T08:00:00Z'),
    });
    expect(row).toMatchObject({ customerId: CUSTOMER, repId: REP, hadSale: false });
  });

  // The whole point of the split: entry says no sale, the voucher says sale.
  it('latches hadSale true once a sale happens', async () => {
    const existing = {
      hadSale: false,
      visitedAt: new Date('2026-08-02T08:00:00Z'),
      lat: null,
      lng: null,
      visitNote: null,
    };
    const { service } = build(existing);
    const row = await service.recordVisit({
      customerId: CUSTOMER,
      repId: REP,
      hadSale: true,
      visitedAt: new Date('2026-08-02T09:30:00Z'),
    });
    expect((row as unknown as { hadSale: boolean }).hadSale).toBe(true);
  });

  // A later no-sale open must not erase the sale that already happened.
  it('never un-sets hadSale', async () => {
    const existing = {
      hadSale: true,
      visitedAt: new Date('2026-08-02T09:00:00Z'),
      lat: null,
      lng: null,
      visitNote: null,
    };
    const { service } = build(existing);
    const row = await service.recordVisit({
      customerId: CUSTOMER,
      repId: REP,
      hadSale: false,
      visitedAt: new Date('2026-08-02T16:00:00Z'),
    });
    expect((row as unknown as { hadSale: boolean }).hadSale).toBe(true);
  });

  it('keeps the earliest arrival time', async () => {
    const existing = {
      hadSale: false,
      visitedAt: new Date('2026-08-02T09:00:00Z'),
      lat: null,
      lng: null,
      visitNote: null,
    };
    const { service } = build(existing);
    const row = (await service.recordVisit({
      customerId: CUSTOMER,
      repId: REP,
      visitedAt: new Date('2026-08-02T07:15:00Z'),
    })) as unknown as { visitedAt: Date };
    expect(row.visitedAt.toISOString()).toBe('2026-08-02T07:15:00.000Z');
  });

  it('does not let a later call push the arrival time forward', async () => {
    const existing = {
      hadSale: false,
      visitedAt: new Date('2026-08-02T07:15:00Z'),
      lat: null,
      lng: null,
      visitNote: null,
    };
    const { service } = build(existing);
    const row = (await service.recordVisit({
      customerId: CUSTOMER,
      repId: REP,
      visitedAt: new Date('2026-08-02T18:00:00Z'),
    })) as unknown as { visitedAt: Date };
    expect(row.visitedAt.toISOString()).toBe('2026-08-02T07:15:00.000Z');
  });

  // The rep was indoors on entry and got a fix by the time they sold.
  it('fills coordinates when the row still has none', async () => {
    const existing = {
      hadSale: false,
      visitedAt: new Date('2026-08-02T08:00:00Z'),
      lat: null,
      lng: null,
      visitNote: null,
    };
    const { service } = build(existing);
    const row = (await service.recordVisit({
      customerId: CUSTOMER,
      repId: REP,
      lat: 31.95,
      lng: 35.92,
    })) as unknown as { lat: number; lng: number };
    expect([row.lat, row.lng]).toEqual([31.95, 35.92]);
  });

  it('keeps the first real fix rather than a later missing one', async () => {
    const existing = {
      hadSale: false,
      visitedAt: new Date('2026-08-02T08:00:00Z'),
      lat: 31.95,
      lng: 35.92,
      visitNote: null,
    };
    const { service } = build(existing);
    const row = (await service.recordVisit({
      customerId: CUSTOMER,
      repId: REP,
      lat: null,
      lng: null,
    })) as unknown as { lat: number; lng: number };
    expect([row.lat, row.lng]).toEqual([31.95, 35.92]);
  });

  it('does not overwrite a reason the rep already gave', async () => {
    const existing = {
      hadSale: false,
      visitedAt: new Date('2026-08-02T08:00:00Z'),
      lat: null,
      lng: null,
      visitNote: 'store closed',
    };
    const { service } = build(existing);
    const row = (await service.recordVisit({
      customerId: CUSTOMER,
      repId: REP,
      visitNote: 'something else',
    })) as unknown as { visitNote: string };
    expect(row.visitNote).toBe('store closed');
  });
});
