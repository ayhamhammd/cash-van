import { ErpSyncService, type ErpStatement } from './erp-sync.service';

/**
 * Reading a statement updates the dashboard's balance — but only when the window
 * it was read for actually ends now.
 *
 * The danger this guards is quiet and fleet-wide: a closing balance is the balance
 * on the LAST DAY OF ITS WINDOW, so a rep idly opening last month's statement would
 * write last month's figure onto the customer, and the next catalogue refresh would
 * carry it to every handset. A look at history must not move money.
 */
describe('ErpSyncService statement balance mirror', () => {
  const today = new Date().toLocaleDateString('en-CA');

  function statement(closingBalance: number, to: string | null = null): ErpStatement {
    return {
      customerId: 'erp-1',
      customerCode: 'CUST-000013',
      customerName: 'shop',
      creditLimit: 0,
      from: null,
      to,
      openingBalance: 0,
      closingBalance,
      lines: [],
    };
  }

  /**
   * Just the surface the mirror touches. Declared standalone rather than
   * intersected with ErpSyncService: the class's `logger` is private, and an
   * intersection that redeclares it collapses the whole type to `never`.
   */
  interface Mirror {
    mirrorStatementBalance: (
      id: string,
      erp: ErpStatement,
      range: { from?: string; to?: string },
    ) => Promise<void>;
  }

  /** A service with just enough of itself to run the mirror, plus a spy repo. */
  function service() {
    const updates: Array<Record<string, unknown>> = [];
    const svc = Object.create(ErpSyncService.prototype) as unknown as Mirror;
    Object.defineProperty(svc, 'customers', {
      value: {
        update: (_w: unknown, v: Record<string, unknown>) => {
          updates.push(v);
          return Promise.resolve();
        },
      },
      configurable: true,
    });
    Object.defineProperty(svc, 'logger', {
      value: { warn: () => undefined },
      configurable: true,
    });
    return { svc, updates };
  }

  it('mirrors an open-ended window, which always means "up to now"', async () => {
    const { svc, updates } = service();
    await svc.mirrorStatementBalance('c1', statement(120.75), {});
    expect(updates).toEqual([{ totalDebt: '120.75' }]);
  });

  it('writes two decimals, which is all the column holds', () => {
    // NOT a rule this code invented: customers.total_debt is numeric(14,2) and
    // pullCustomerBalances() already rounds the same way. Recorded here because
    // JOD carries THREE decimals (fils), so a balance of 260.325 lands as 260.32
    // and the last fil is lost on the dashboard. The handset keeps its own
    // 3-decimal arithmetic; only this mirrored column is coarse.
    expect((260.325).toFixed(2)).toBe('260.32');
  });

  it('mirrors a window that ends today', async () => {
    const { svc, updates } = service();
    await svc.mirrorStatementBalance('c1', statement(120.5), { to: today });
    expect(updates).toEqual([{ totalDebt: '120.50' }]);
  });

  it('mirrors a window that ends in the future', async () => {
    const { svc, updates } = service();
    await svc.mirrorStatementBalance('c1', statement(5), { to: '2099-12-31' });
    expect(updates).toHaveLength(1);
  });

  it('does NOT mirror a window that ended in the past', async () => {
    // The case that would have been a fleet-wide wrong number: a rep looking at
    // last month writes last month's closing balance over the live one.
    const { svc, updates } = service();
    await svc.mirrorStatementBalance('c1', statement(999), { to: '2020-01-31' });
    expect(updates).toEqual([]);
  });

  it('falls back to the statement own end date when the caller named no range', async () => {
    const { svc, updates } = service();
    await svc.mirrorStatementBalance('c1', statement(999, '2020-01-31'), {});
    expect(updates).toEqual([]);
  });

  it('accepts a full ISO timestamp, not just a bare day', async () => {
    const { svc, updates } = service();
    await svc.mirrorStatementBalance('c1', statement(7), { to: `${today}T23:59:59Z` });
    expect(updates).toHaveLength(1);
  });

  it('writes nothing when the ERP sent a balance that is not a number', async () => {
    const { svc, updates } = service();
    await svc.mirrorStatementBalance('c1', statement(Number.NaN), {});
    expect(updates).toEqual([]);
  });

  it('never throws when the write fails - the statement still displayed', async () => {
    const { svc } = service();
    Object.defineProperty(svc, 'customers', {
      value: { update: () => Promise.reject(new Error('db down')) },
      configurable: true,
    });
    await expect(
      svc.mirrorStatementBalance('c1', statement(10), {}),
    ).resolves.toBeUndefined();
  });
});
