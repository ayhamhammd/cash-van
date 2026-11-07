import { AuthService } from './auth.service';

/**
 * auth/me carries the rep's role (docs/SPEC-delivery-rep.md §6.3): `repKind`
 * and `permissions.canDeliver`, read fresh so an admin's change reaches the
 * phone on its next refresh.
 */
describe('AuthService.profile — delivery rep fields', () => {
  function makeSvc(rep: { kind: string } | null) {
    const svc = Object.create(AuthService.prototype) as Record<string, unknown>;
    svc.usersService = {
      findOneOrThrow: async () => ({
        id: 'u-1',
        name: 'Rep',
        role: 'viewer',
        userType: 'SALES',
        permissions: [],
        canMakeCollection: true,
      }),
    };
    svc.repsService = { findByUserId: async () => rep };
    return svc as unknown as AuthService;
  }
  const me = (rep: { kind: string } | null) =>
    makeSvc(rep).profile({ sub: 'u-1' }) as Promise<{
      repKind: string;
      permissions: Record<string, boolean>;
    }>;

  it.each([
    ['DELIVERY', true],
    ['BOTH', true],
    ['SALES', false],
  ])('%s → canDeliver %s', async (kind, can) => {
    const out = await me({ kind });
    expect(out.repKind).toBe(kind);
    expect(out.permissions.canDeliver).toBe(can);
    expect(out.permissions.canMakeCollection).toBe(true);
  });

  it('a user with no rep is SALES and cannot deliver', async () => {
    const out = await me(null);
    expect(out.repKind).toBe('SALES');
    expect(out.permissions.canDeliver).toBe(false);
  });
});
