import { ArService } from './ar.service';

/**
 * Every receivables query is bound with ONE shared params array, so each query
 * must reference every parameter in it.
 *
 * Postgres refuses a bind that supplies more parameters than the statement
 * uses — "bind message supplies 5 parameters, but prepared statement requires
 * 4" — and it refuses at execution time, not at build time. The credit-returns
 * query referenced only $1..$3 while being handed four, which took the whole
 * Receivables page down with a 500 that nothing in CI could see.
 *
 * Asserting the arity rather than the text means the next filter added here
 * cannot reintroduce it by being pasted into three queries and forgotten in
 * the fourth.
 */
describe('ArService.receivables — every query binds what it references', () => {
  /** Highest $n appearing in a statement. */
  const highestParam = (sql: string): number =>
    [...sql.matchAll(/\$(\d+)/g)].reduce((max, m) => Math.max(max, Number(m[1])), 0);

  function makeSvc(capture: Array<{ sql: string; params: unknown[] }>): ArService {
    const ds = {
      query: jest.fn((sql: string, params: unknown[] = []) => {
        capture.push({ sql, params });
        return Promise.resolve([]);
      }),
    };
    return new (ArService as unknown as new (...a: unknown[]) => ArService)(
      null, null, null, null, ds,
    );
  }

  it('references every bound parameter, in every query', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    await makeSvc(calls).receivables(
      { from: '2026-01-01', to: '2026-12-31', customerNumber: '1', repId: 'r-1' },
      ['rep-a'],
    );

    expect(calls.length).toBeGreaterThan(0);
    for (const { sql, params } of calls) {
      // Not "<=": an unreferenced trailing parameter is the exact bug.
      expect(highestParam(sql)).toBe(params.length);
    }
  });

  it('passes the chosen salesman through as a bound parameter, never inlined', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    await makeSvc(calls).receivables({ repId: 'rep-42' }, null);

    for (const { sql, params } of calls) {
      expect(params).toContain('rep-42');
      // Interpolating it into the text would make the filter injectable.
      expect(sql).not.toContain('rep-42');
    }
  });

  it('treats a blank salesman as no filter rather than as an id', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    await makeSvc(calls).receivables({ repId: '   ' }, null);

    for (const { params } of calls) expect(params).toContain(null);
  });
});
