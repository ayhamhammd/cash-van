import type { DataSource } from 'typeorm';

import { ContainersController } from './containers.controller';
import { ContainersService } from './containers.service';
import type { ContainerBalanceQueryDto } from './dto/container-balance.query';
import type { RepScopeService } from '../users/rep-scope.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * Who may see whose packaging.
 *
 * The container endpoints are open to any authenticated user, like the other
 * screens the handset reads, so the rep scope is the ONLY thing standing
 * between a salesman and the whole company's outstanding containers. It is
 * answered by `RepScopeService` — the same service the reports use — and not
 * re-derived here, because a second implementation of "which salesmen may this
 * user see" is how the two would start disagreeing.
 *
 * The contract being pinned (docs/SPEC-rep-scoped-users.md):
 *
 *   null      → unrestricted, no filter
 *   string[]  → these rep ids only, and an EMPTY array sees NOTHING
 *
 * Scoped on who owns the CUSTOMER rather than on who last moved the packaging:
 * the rep who has to collect the empties is the one whose customer is holding
 * them, and that must not change because a colleague covered the round.
 */
function fakeDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const dataSource = {
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return Promise.resolve([]);
    },
  } as unknown as DataSource;
  return { dataSource, calls, svc: new ContainersService(dataSource) };
}

const REPS = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];

describe('container balances — the rep scope', () => {
  it('applies NO rep filter for an unrestricted caller', async () => {
    const { svc, calls } = fakeDb();
    await svc.balances({ visibleRepIds: null });
    expect(calls[0].sql).not.toMatch(/rep_id/);
    expect(calls[0].params).not.toContainEqual(REPS);
  });

  it('narrows to the customers of the salesmen the caller may see', async () => {
    const { svc, calls } = fakeDb();
    await svc.balances({ visibleRepIds: REPS });
    expect(calls[0].sql).toMatch(/c\.rep_id = ANY\(\$\d+::uuid\[\]\)/);
    expect(calls[0].params).toContainEqual(REPS);
  });

  it('shows NOTHING to a scoped caller with no salesmen assigned', async () => {
    // Fail closed. The single most likely bug in rep scoping is treating an
    // empty scope as "no filter", which would hand a supervisor with no
    // assignments the whole company — `= ANY('{}')` matches no row instead.
    const { svc, calls } = fakeDb();
    await svc.balances({ visibleRepIds: [] });
    expect(calls[0].sql).toMatch(/c\.rep_id = ANY\(/);
    expect(calls[0].params).toContainEqual([]);
  });

  it('scopes the totals the same way, so a header adds up to its own list', async () => {
    const { svc, calls } = fakeDb();
    await svc.totals({ visibleRepIds: REPS });
    expect(calls[0].sql).toMatch(/c\.rep_id = ANY\(/);
    expect(calls[0].sql).toMatch(/LEFT JOIN customers c/);
    expect(calls[0].params).toContainEqual(REPS);
  });

  it('scopes one customer as tightly as the list it zooms into', async () => {
    // Naming a customer directly must not reach a salesman the caller cannot
    // see — the mistake the reports made once already.
    const { svc, calls } = fakeDb();
    await svc.forCustomer('CUST-1', REPS);
    expect(calls[0].sql).toMatch(/c\.rep_id = ANY\(/);
    expect(calls[0].params).toContainEqual(REPS);
    expect(calls[0].params).toContainEqual('CUST-1');
  });

  it('keeps userCode a filter: it narrows the caller’s own view, never widens it', async () => {
    const { svc, calls } = fakeDb();
    await svc.balances({ userCode: '999', visibleRepIds: REPS });
    // BOTH conditions, ANDed: asking after another rep's code still only
    // reaches the customers this caller is allowed to see.
    expect(calls[0].sql).toMatch(/cb\.last_user_code = \$\d+/);
    expect(calls[0].sql).toMatch(/c\.rep_id = ANY\(/);
    expect(calls[0].sql).toMatch(/ AND /);
  });
});

describe('container balances — the controller takes the scope from the token', () => {
  function controller(visible: string[] | null) {
    const seen: Array<Record<string, unknown>> = [];
    const containers = {
      balances: (q: Record<string, unknown>) => {
        seen.push(q);
        return Promise.resolve([]);
      },
      totals: (o: Record<string, unknown>) => {
        seen.push(o);
        return Promise.resolve([]);
      },
      forCustomer: (customerNumber: string, visibleRepIds?: string[] | null) => {
        seen.push({ customerNumber, visibleRepIds });
        return Promise.resolve([]);
      },
    } as unknown as ContainersService;
    const repScope = {
      visibleRepIds: jest.fn().mockResolvedValue(visible),
    } as unknown as RepScopeService;
    return { ctl: new ContainersController(containers, repScope), seen };
  }

  const user = { sub: 'u1', repId: REPS[0] } as AuthenticatedUser;

  it('asks RepScopeService rather than reading a role off the token', async () => {
    const { ctl, seen } = controller(REPS);
    await ctl.balances({} as ContainerBalanceQueryDto, user);
    expect(seen[0].visibleRepIds).toEqual(REPS);
  });

  it('overrides a scope a client tries to send in the query string', async () => {
    // The DTO has no such field, so a whitelisting validator strips it — but
    // the scope is applied AFTER the spread regardless, so a client that got
    // one through would still be answered with its own token's scope.
    const { ctl, seen } = controller(REPS);
    await ctl.balances(
      { visibleRepIds: ['99999999-9999-9999-9999-999999999999'] } as ContainerBalanceQueryDto,
      user,
    );
    expect(seen[0].visibleRepIds).toEqual(REPS);
  });

  it('scopes totals and one-customer reads too, not just the list', async () => {
    const { ctl, seen } = controller(REPS);
    await ctl.totals(user, '101');
    await ctl.forCustomer('CUST-1', user);
    expect(seen[0]).toEqual({ userCode: '101', visibleRepIds: REPS });
    expect(seen[1]).toEqual({ customerNumber: 'CUST-1', visibleRepIds: REPS });
  });

  it('passes unrestricted through as null, so the office still sees everything', async () => {
    const { ctl, seen } = controller(null);
    await ctl.balances({} as ContainerBalanceQueryDto, user);
    expect(seen[0].visibleRepIds).toBeNull();
  });
});
