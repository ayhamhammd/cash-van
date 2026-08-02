import { NotFoundException } from '@nestjs/common';

import { EMPTY_SCOPE, Scope } from './scope.types';
import {
  applyRepScope,
  applyUserCodeScope,
  assertRepInScope,
  assertUserCodeInScope,
  repInScope,
  userCodeInScope,
} from './scope.util';

/**
 * The helpers every scoped query goes through. A regression here is a leak in
 * every module at once, so each branch is pinned — especially the empty scope,
 * where the wrong behaviour (skip the filter) looks like the right one.
 */
describe('scope.util', () => {
  const ALL: Scope = { kind: 'ALL' };
  const MINE: Scope = {
    kind: 'REPS',
    repIds: ['r1', 'r2'],
    userCodes: ['S001', 'S002'],
  };

  /** Minimal SelectQueryBuilder stand-in that records andWhere() calls. */
  function fakeQb() {
    const calls: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const qb = {
      calls,
      andWhere(sql: string, params?: Record<string, unknown>) {
        calls.push({ sql, params });
        return qb;
      },
    };
    return qb;
  }

  describe('applyRepScope', () => {
    it('leaves the query untouched for a main admin', () => {
      const qb = fakeQb();
      applyRepScope(qb as never, ALL, 'c.rep_id');
      expect(qb.calls).toHaveLength(0);
    });

    it('filters to the scoped rep ids', () => {
      const qb = fakeQb();
      applyRepScope(qb as never, MINE, 'c.rep_id');

      expect(qb.calls).toHaveLength(1);
      expect(qb.calls[0].sql).toMatch(/^c\.rep_id IN \(:\.\.\.scopeRepIds\d+\)$/);
      expect(Object.values(qb.calls[0].params ?? {})[0]).toEqual(['r1', 'r2']);
    });

    // The one that matters: an empty scope must match nothing, not everything.
    it('matches no rows for an empty scope', () => {
      const qb = fakeQb();
      applyRepScope(qb as never, EMPTY_SCOPE, 'c.rep_id');

      expect(qb.calls).toEqual([{ sql: '1 = 0', params: undefined }]);
    });

    it('uses distinct parameter names when applied twice to one builder', () => {
      const qb = fakeQb();
      applyRepScope(qb as never, MINE, 'a.rep_id');
      applyRepScope(qb as never, MINE, 'b.rep_id');

      expect(qb.calls[0].sql).not.toEqual(qb.calls[1].sql);
      const names = qb.calls.map((c) => Object.keys(c.params ?? {})[0]);
      expect(names[0]).not.toEqual(names[1]);
    });
  });

  describe('applyUserCodeScope', () => {
    it('filters to the scoped user codes', () => {
      const qb = fakeQb();
      applyUserCodeScope(qb as never, MINE, 'h.user_code');

      expect(qb.calls[0].sql).toMatch(
        /^h\.user_code IN \(:\.\.\.scopeUserCodes\d+\)$/,
      );
      expect(Object.values(qb.calls[0].params ?? {})[0]).toEqual([
        'S001',
        'S002',
      ]);
    });

    // Reps assigned but none of them has a login: there is nothing to show.
    it('matches no rows when the scope has reps but no user codes', () => {
      const qb = fakeQb();
      applyUserCodeScope(
        qb as never,
        { kind: 'REPS', repIds: ['r1'], userCodes: [] },
        'h.user_code',
      );

      expect(qb.calls).toEqual([{ sql: '1 = 0', params: undefined }]);
    });
  });

  describe('membership', () => {
    it.each([
      ['r1', true],
      ['r9', false],
      [null, false],
      [undefined, false],
    ])('repInScope(%s) === %s', (repId, expected) => {
      expect(repInScope(MINE, repId as string | null)).toBe(expected);
    });

    it('admits anything for a main admin — including a missing id', () => {
      expect(repInScope(ALL, 'anything')).toBe(true);
      expect(repInScope(ALL, null)).toBe(true);
      expect(userCodeInScope(ALL, null)).toBe(true);
    });

    it('admits nothing under an empty scope', () => {
      expect(repInScope(EMPTY_SCOPE, 'r1')).toBe(false);
      expect(userCodeInScope(EMPTY_SCOPE, 'S001')).toBe(false);
    });
  });

  describe('assertions', () => {
    it('passes an in-scope record through', () => {
      expect(() => assertRepInScope(MINE, 'r1')).not.toThrow();
      expect(() => assertUserCodeInScope(MINE, 'S001')).not.toThrow();
    });

    // 404, never 403: a 403 confirms the record exists.
    it('throws NotFound for an out-of-scope record', () => {
      expect(() => assertRepInScope(MINE, 'r9', 'Collection')).toThrow(
        NotFoundException,
      );
      expect(() => assertRepInScope(MINE, 'r9', 'Collection')).toThrow(
        'Collection not found',
      );
      expect(() => assertUserCodeInScope(MINE, 'S009', 'Voucher')).toThrow(
        NotFoundException,
      );
    });
  });
});
