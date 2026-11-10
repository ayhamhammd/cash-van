import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { DeliveryFeatureGuard } from './delivery-feature.guard';
import { DeliveriesController } from './deliveries.controller';
import { RepsService } from '../reps/reps.service';
import { UsersService } from '../users/users.service';
import { addedDeliveryKeys } from '../../common/constants/permissions';

/** Delivery & collection master switch (Program features), with the switch off and on. */
describe('delivery switch — the office’s screens', () => {
  const ctx = (exempt: boolean) =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      _exempt: exempt,
    }) as never;
  const guard = (on: boolean, exempt = false) =>
    new DeliveryFeatureGuard(
      { deliveryEnabled: async () => on } as never,
      { getAllAndOverride: () => exempt } as never,
    );

  it('off: 403 FEATURE_DISABLED with a clear message', async () => {
    const err = await guard(false).canActivate(ctx(false)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual({
      code: 'FEATURE_DISABLED',
      message: 'Delivery & collection is turned off in Program features',
    });
  });

  it('on: through; a badge-count route is through either way', async () => {
    expect(await guard(true).canActivate(ctx(false))).toBe(true);
    expect(await guard(false, true).canActivate(ctx(true))).toBe(true);
  });

  it('the badge counts answer { pending: 0 } while off, the real count when on', async () => {
    const make = (on: boolean) => {
      const c = Object.create(DeliveriesController.prototype) as Record<string, unknown>;
      c.settings = { deliveryEnabled: async () => on };
      c.returns = { count: async () => ({ pending: 4 }) };
      c.increases = { count: async () => ({ pending: 2 }) };
      return c as unknown as DeliveriesController;
    };
    expect(await make(false).countReturns()).toEqual({ pending: 0 });
    expect(await make(false).countIncreases()).toEqual({ pending: 0 });
    expect(await make(true).countReturns()).toEqual({ pending: 4 });
    expect(await make(true).countIncreases()).toEqual({ pending: 2 });
  });
});

describe('delivery switch — the rep type', () => {
  function svc(on: boolean) {
    const s = Object.create(RepsService.prototype) as Record<string, unknown>;
    s.settings = { deliveryEnabled: async () => on };
    return s as unknown as { assertKindAllowed(next?: string, current?: string): Promise<void> };
  }

  it.each(['DELIVERY', 'BOTH'])('off: a rep cannot be made %s (400 FEATURE_DISABLED)', async (kind) => {
    const err = await svc(false).assertKindAllowed(kind, 'SALES').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'FEATURE_DISABLED' });
    // A new rep asking for it is refused too.
    await expect(svc(false).assertKindAllowed(kind, undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('off: no kind, the same kind, or back to SALES still save — an existing delivery rep stays editable', async () => {
    await expect(svc(false).assertKindAllowed(undefined, 'DELIVERY')).resolves.toBeUndefined();
    await expect(svc(false).assertKindAllowed('DELIVERY', 'DELIVERY')).resolves.toBeUndefined();
    await expect(svc(false).assertKindAllowed('BOTH', 'BOTH')).resolves.toBeUndefined();
    await expect(svc(false).assertKindAllowed('SALES', 'DELIVERY')).resolves.toBeUndefined();
    await expect(svc(false).assertKindAllowed('SALES', undefined)).resolves.toBeUndefined();
  });

  it('on: any kind', async () => {
    await expect(svc(true).assertKindAllowed('DELIVERY', 'SALES')).resolves.toBeUndefined();
  });
});

describe('delivery switch — permission keys', () => {
  it('only keys being granted count; removing or keeping one never does', () => {
    expect(addedDeliveryKeys(['deliveries.view'], ['deliveries.view', 'deliveries.manage', 'areas.view'])).toEqual([
      'deliveries.manage',
    ]);
    expect(addedDeliveryKeys(['deliveries.view', 'deliveries.manage'], ['deliveries.view'])).toEqual([]);
    expect(addedDeliveryKeys(null, ['segments.edit'])).toEqual([]);
  });

  function users(on: boolean, current: string[] = []) {
    const s = Object.create(UsersService.prototype) as Record<string, unknown>;
    const saved: unknown[] = [];
    s.usersRepo = {
      manager: { query: async () => [{ on }] },
      findOne: async () => ({ id: 'u1', permissions: current }),
      save: async (u: unknown) => (saved.push(u), u),
    };
    s.repScope = { setScope: async () => undefined };
    return { svc: s as unknown as UsersService, saved };
  }

  it('off: granting deliveries.* is 400 FEATURE_DISABLED; taking it away or keeping it saves', async () => {
    await expect(users(false).svc.update('u1', { permissions: ['deliveries.view'] } as never)).rejects.toMatchObject({
      response: { code: 'FEATURE_DISABLED' },
    });
    const keep = users(false, ['deliveries.view', 'areas.view']);
    await expect(keep.svc.update('u1', { permissions: ['deliveries.view'] } as never)).resolves.toBeDefined();
    await expect(keep.svc.update('u1', { permissions: [] } as never)).resolves.toBeDefined();
    await expect(keep.svc.update('u1', { name: 'x' } as never)).resolves.toBeDefined();
  });

  it('on: granting is fine', async () => {
    await expect(users(true).svc.update('u1', { permissions: ['deliveries.manage'] } as never)).resolves.toBeDefined();
  });
});

describe('delivery switch — the dashboard leaves kind out of the rep PATCH', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { plainToInstance } = require('class-transformer');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { UpdateRepDto } = require('../reps/dto/update-rep.dto');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { provisionRep } = require('../reps/rep-provision');

  it('off: a PATCH without kind saves and keeps the stored DELIVERY kind', async () => {
    const rep = { id: 'r1', kind: 'DELIVERY', code: 'D1', nameAr: 'د' };
    const s = Object.create(RepsService.prototype) as Record<string, unknown>;
    s.repo = { findOne: async () => rep, save: async (r: unknown) => r };
    s.settings = { getErpConfig: async () => ({ enabled: false }), deliveryEnabled: async () => false };
    // As the global pipe hands it over: an omitted field is not on the DTO at all.
    const dto = plainToInstance(UpdateRepDto, { phone: '0790000000' }, { enableImplicitConversion: true });
    expect('kind' in dto).toBe(false);
    const saved = (await (s as unknown as RepsService).update('r1', dto)) as unknown as typeof rep & { phone: string };
    expect(saved).toMatchObject({ kind: 'DELIVERY', phone: '0790000000' });
  });

  it('a new rep with no kind is SALES', async () => {
    const saved: Array<Record<string, unknown>> = [];
    const repo = (store?: Record<string, unknown>) => ({
      findOne: async () => store ?? null,
      create: (o: Record<string, unknown>) => ({ ...o }),
      save: async (o: Record<string, unknown>) => (saved.push(o), { id: 'x', ...o }),
    });
    const em = { getRepository: (e: { name: string }) => (e.name === 'Warehouse' ? repo({ id: 'wh' }) : repo()) };
    const rep = await provisionRep(em as never, { code: 'S9', nameAr: 'س', userId: 'u9' });
    expect(rep.kind).toBe('SALES');
  });
});
