import { ForbiddenException } from '@nestjs/common';
import {
  CustomerProximityService,
  PERM_REQUIRE_PROXIMITY,
} from './customer-proximity.service';

/**
 * Unit tests for the per-rep location lock. The service is built by hand with
 * lightweight mocks so we exercise the real haversine + branch logic without a
 * Nest context or a database.
 */
describe('CustomerProximityService', () => {
  const AMMAN = { lat: 31.951569, lng: 35.923963 }; // customer pin
  const NEAR = { lat: 31.9525, lng: 35.924 }; // ~105 m away
  const FAR = { lat: 32.02, lng: 35.99 }; // ~9 km away

  type Ctx = { userId: string; role: string } | null;

  function build(opts: {
    ctx?: Ctx;
    permissions?: string[];
    userType?: string;
    customer?: {
      id?: string;
      customerNumber?: string;
      latitude?: string | null;
      longitude?: string | null;
    } | null;
    radiusM?: number;
  }) {
    const seedLocation = jest.fn().mockResolvedValue({});
    const customer =
      opts.customer === undefined
        ? { id: 'c1', customerNumber: 'CUST-1', latitude: null, longitude: null }
        : opts.customer;
    const customersRepo = { findOne: jest.fn().mockResolvedValue(customer) };
    const usersRepo = {
      findOne: jest.fn().mockResolvedValue(
        opts.ctx
          ? {
              id: opts.ctx.userId,
              userType: opts.userType ?? 'SALES',
              permissions: opts.permissions ?? [PERM_REQUIRE_PROXIMITY],
            }
          : null,
      ),
    };
    const userCtx = { get: () => (opts.ctx ?? null) as Ctx };
    const config = { get: () => opts.radiusM ?? 1000 };
    const svc = new CustomerProximityService(
      customersRepo as never,
      usersRepo as never,
      { seedLocation } as never,
      userCtx as never,
      config as never,
    );
    return { svc, seedLocation, customersRepo };
  }

  it('no-ops for internal (context-less) calls', async () => {
    const { svc, customersRepo } = build({ ctx: null });
    await expect(
      svc.enforce({ customerNumber: 'CUST-1', repLat: FAR.lat, repLng: FAR.lng }),
    ).resolves.toBeUndefined();
    expect(customersRepo.findOne).not.toHaveBeenCalled();
  });

  it('no-ops for admin/manager roles', async () => {
    const { svc } = build({ ctx: { userId: 'u1', role: 'admin' } });
    await expect(
      svc.enforce({ customerNumber: 'CUST-1', repLat: FAR.lat, repLng: FAR.lng }),
    ).resolves.toBeUndefined();
  });

  it('no-ops for a rep without the requireProximity permission', async () => {
    const { svc } = build({
      ctx: { userId: 'u1', role: 'salesman' },
      permissions: [],
      customer: {
        id: 'c1',
        customerNumber: 'CUST-1',
        latitude: String(AMMAN.lat),
        longitude: String(AMMAN.lng),
      },
    });
    // Far away, but unrestricted → allowed.
    await expect(
      svc.enforce({ customerNumber: 'CUST-1', repLat: FAR.lat, repLng: FAR.lng }),
    ).resolves.toBeUndefined();
  });

  it('allows a restricted rep within the radius', async () => {
    const { svc } = build({
      ctx: { userId: 'u1', role: 'salesman' },
      customer: {
        id: 'c1',
        customerNumber: 'CUST-1',
        latitude: String(AMMAN.lat),
        longitude: String(AMMAN.lng),
      },
    });
    await expect(
      svc.enforce({ customerNumber: 'CUST-1', repLat: NEAR.lat, repLng: NEAR.lng }),
    ).resolves.toBeUndefined();
  });

  it('blocks a restricted rep outside the radius', async () => {
    const { svc } = build({
      ctx: { userId: 'u1', role: 'salesman' },
      customer: {
        id: 'c1',
        customerNumber: 'CUST-1',
        latitude: String(AMMAN.lat),
        longitude: String(AMMAN.lng),
      },
    });
    await expect(
      svc.enforce({ customerNumber: 'CUST-1', repLat: FAR.lat, repLng: FAR.lng }),
    ).rejects.toMatchObject({
      response: { code: 'outside_customer_geofence' },
    });
  });

  it('seeds a missing customer location from the rep fix and allows', async () => {
    const { svc, seedLocation } = build({
      ctx: { userId: 'u1', role: 'salesman' },
      customer: { id: 'c1', customerNumber: 'CUST-1', latitude: null, longitude: null },
    });
    await expect(
      svc.enforce({ customerNumber: 'CUST-1', repLat: NEAR.lat, repLng: NEAR.lng }),
    ).resolves.toBeUndefined();
    expect(seedLocation).toHaveBeenCalledWith('c1', NEAR.lat, NEAR.lng);
  });

  it('blocks when the customer has no location and no rep fix (cannot seed)', async () => {
    const { svc, seedLocation } = build({
      ctx: { userId: 'u1', role: 'salesman' },
      customer: { id: 'c1', customerNumber: 'CUST-1', latitude: null, longitude: null },
    });
    await expect(
      svc.enforce({ customerNumber: 'CUST-1' }),
    ).rejects.toMatchObject({ response: { code: 'location_required' } });
    expect(seedLocation).not.toHaveBeenCalled();
  });

  it('blocks when the customer has a location but the rep has no fix', async () => {
    const { svc } = build({
      ctx: { userId: 'u1', role: 'salesman' },
      customer: {
        id: 'c1',
        customerNumber: 'CUST-1',
        latitude: String(AMMAN.lat),
        longitude: String(AMMAN.lng),
      },
    });
    await expect(svc.enforce({ customerNumber: 'CUST-1' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('no-ops when there is no customer to anchor to', async () => {
    const { svc } = build({
      ctx: { userId: 'u1', role: 'salesman' },
      customer: null,
    });
    await expect(
      svc.enforce({ customerNumber: 'CUST-404', repLat: FAR.lat, repLng: FAR.lng }),
    ).resolves.toBeUndefined();
  });
});
