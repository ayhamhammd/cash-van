import { ScopeService } from './scope.service';
import { EMPTY_SCOPE, isEmptyScope, isUnscoped, Scope } from './scope.types';

/**
 * Unit tests for scope resolution — the single point that decides whose data a
 * request may touch. Built by hand with lightweight mocks so the branch logic
 * is exercised without a Nest context or a database.
 *
 * The case that matters most is the last rule: a non-admin with no assignment
 * must resolve to *nothing*, not to everything.
 */
describe('ScopeService', () => {
  type Link = { repId: string };
  type CodeRow = { code: string | null };

  function build(opts: {
    links?: Link[];
    codes?: CodeRow[];
    /** The rep row this user IS, if any (rule 3). */
    ownRep?: { id: string } | null;
    ctx?: { userId: string; role: string } | null;
    clsActive?: boolean;
  }) {
    const linksFind = jest.fn().mockResolvedValue(opts.links ?? []);
    const repsFindOne = jest.fn().mockResolvedValue(opts.ownRep ?? null);
    const getRawMany = jest.fn().mockResolvedValue(opts.codes ?? []);
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawMany,
    };

    const store = new Map<string, unknown>();
    const cls = {
      isActive: () => opts.clsActive ?? true,
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => store.set(k, v),
    };

    const service = new ScopeService(
      { find: linksFind } as never,
      { createQueryBuilder: () => qb, findOne: repsFindOne } as never,
      {
        get: () => (opts.ctx === undefined ? { userId: 'u1', role: 'viewer' } : opts.ctx),
      } as never,
      cls as never,
    );

    return { service, linksFind, getRawMany, repsFindOne };
  }

  describe('forUser', () => {
    it('resolves a main admin to ALL, without querying assignments', async () => {
      const { service, linksFind } = build({});
      const scope = await service.forUser('u1', 'admin');

      expect(scope).toEqual({ kind: 'ALL' });
      expect(isUnscoped(scope)).toBe(true);
      expect(linksFind).not.toHaveBeenCalled();
    });

    it('resolves an assigned user to their reps and matching user codes', async () => {
      const { service } = build({
        links: [{ repId: 'r1' }, { repId: 'r2' }],
        codes: [{ code: 'S001' }, { code: 'S002' }],
      });

      const scope = await service.forUser('u1', 'supervisor');

      expect(scope).toEqual({
        kind: 'REPS',
        repIds: ['r1', 'r2'],
        userCodes: ['S001', 'S002'],
      });
      expect(isEmptyScope(scope)).toBe(false);
    });

    // Deny by default. The whole feature rests on this one.
    it.each(['supervisor', 'manager', 'viewer', 'anything-else'])(
      'resolves an unassigned %s to an empty scope, never to ALL',
      async (role) => {
        const { service } = build({ links: [], ownRep: null });
        const scope = await service.forUser('u1', role);

        expect(scope).toEqual(EMPTY_SCOPE);
        expect(isUnscoped(scope)).toBe(false);
        expect(isEmptyScope(scope)).toBe(true);
      },
    );

    // Rule 3 — without this a salesman's own login resolves to nothing and the
    // mobile app loses access to its own data.
    it('resolves a salesman to their own rep when they have no assignment', async () => {
      const { service } = build({
        links: [],
        ownRep: { id: 'rOwn' },
        codes: [{ code: 'S007' }],
      });

      const scope = await service.forUser('u1', 'viewer');

      expect(scope).toEqual({
        kind: 'REPS',
        repIds: ['rOwn'],
        userCodes: ['S007'],
      });
    });

    it('prefers the supervisor assignment over the user’s own rep', async () => {
      const { service, repsFindOne } = build({
        links: [{ repId: 'r1' }],
        ownRep: { id: 'rOwn' },
        codes: [{ code: 'S001' }],
      });

      const scope = (await service.forUser('u1', 'supervisor')) as Extract<
        Scope,
        { kind: 'REPS' }
      >;

      expect(scope.repIds).toEqual(['r1']);
      expect(repsFindOne).not.toHaveBeenCalled();
    });

    it('de-duplicates rep ids and user codes', async () => {
      const { service } = build({
        links: [{ repId: 'r1' }, { repId: 'r1' }, { repId: 'r2' }],
        codes: [{ code: 'S001' }, { code: 'S001' }],
      });

      const scope = (await service.forUser('u1', 'supervisor')) as Extract<
        Scope,
        { kind: 'REPS' }
      >;

      expect(scope.repIds).toEqual(['r1', 'r2']);
      expect(scope.userCodes).toEqual(['S001']);
    });

    // A rep with no login contributes no user_code. Their rep_id-linked rows
    // stay visible; their user_code-linked rows simply don't match. Narrower is
    // the safe direction.
    it('keeps the rep id when the rep has no linked login', async () => {
      const { service } = build({
        links: [{ repId: 'r1' }],
        codes: [{ code: null }],
      });

      const scope = (await service.forUser('u1', 'supervisor')) as Extract<
        Scope,
        { kind: 'REPS' }
      >;

      expect(scope.repIds).toEqual(['r1']);
      expect(scope.userCodes).toEqual([]);
      // Still a usable scope — not the empty one.
      expect(isEmptyScope(scope)).toBe(false);
    });
  });

  describe('forCurrentUser', () => {
    it('fails closed when no user context is resolved', async () => {
      const { service, linksFind } = build({ ctx: null });

      expect(await service.forCurrentUser()).toEqual(EMPTY_SCOPE);
      expect(linksFind).not.toHaveBeenCalled();
    });

    it('resolves once per request and reuses the result', async () => {
      const { service, linksFind } = build({
        links: [{ repId: 'r1' }],
        codes: [{ code: 'S001' }],
        ctx: { userId: 'u1', role: 'supervisor' },
      });

      const first = await service.forCurrentUser();
      const second = await service.forCurrentUser();

      expect(second).toBe(first);
      expect(linksFind).toHaveBeenCalledTimes(1);
    });

    it('still resolves when there is no CLS context to memoise into', async () => {
      const { service } = build({
        links: [{ repId: 'r1' }],
        codes: [{ code: 'S001' }],
        ctx: { userId: 'u1', role: 'supervisor' },
        clsActive: false,
      });

      const scope = (await service.forCurrentUser()) as Extract<
        Scope,
        { kind: 'REPS' }
      >;
      expect(scope.repIds).toEqual(['r1']);
    });
  });

  // Shared constant handed to every caller — a mutation would widen everyone.
  it('exposes EMPTY_SCOPE as a frozen value', () => {
    expect(Object.isFrozen(EMPTY_SCOPE)).toBe(true);
  });
});
