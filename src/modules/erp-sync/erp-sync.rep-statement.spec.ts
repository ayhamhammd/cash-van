import { ErpSyncService } from './erp-sync.service';

/**
 * A salesman's account statement comes from the ERP and nowhere else.
 *
 * His account is the GL account `reps.erp_account_code`. These pin that the
 * statement is read from THAT account, for the window asked, and that every
 * way it can be missing says why instead of falling back to a figure of
 * cash-van's own — which is how the two systems came to disagree.
 */
describe('ErpSyncService.repErpStatementById', () => {
  const STATEMENT = {
    accountId: 'a1', accountCode: '1105-101', accountName: 'قصي', accountType: 'Asset',
    from: '2026-09-01', to: '2026-09-30',
    openingBalance: 100, closingBalance: 70, totalDebit: 20, totalCredit: 50,
    lines: [{ date: '2026-09-10', type: 'JOURNAL', reference: 'JV-1', description: 'x', debit: 20, credit: 50, balance: 70 }],
  };

  function makeSvc(opts: { rep: unknown; erpReady?: boolean; getOne?: jest.Mock }) {
    const svc = Object.create(ErpSyncService.prototype) as Record<string, unknown>;
    const getOne = opts.getOne ?? jest.fn().mockResolvedValue(STATEMENT);
    svc.reps = { findOne: jest.fn().mockResolvedValue(opts.rep) };
    svc.erpConfigReady = jest.fn().mockResolvedValue(opts.erpReady ?? true);
    svc.settings = { getErpConfig: async () => ({ enabled: true, baseUrl: 'http://erp', apiKey: 'k' }) };
    svc.erp = { getOne };
    return { svc: svc as unknown as ErpSyncService, getOne };
  }

  it("reads the salesman's own ERP account, for the window asked", async () => {
    const { svc, getOne } = makeSvc({ rep: { id: 'r1', erpAccountCode: '1105-101' } });
    const out = await svc.repErpStatementById('r1', { from: '2026-09-01', to: '2026-09-30' });
    expect(out).toEqual(STATEMENT);
    expect(getOne).toHaveBeenCalledWith('accounts/by-code/1105-101/statement?from=2026-09-01&to=2026-09-30');
  });

  it('asks for the whole account when no window is given', async () => {
    const { svc, getOne } = makeSvc({ rep: { id: 'r1', erpAccountCode: '1105-101' } });
    await svc.repErpStatementById('r1');
    expect(getOne).toHaveBeenCalledWith('accounts/by-code/1105-101/statement');
  });

  it('says "unlinked" for a salesman with no ERP account — never a local figure', async () => {
    const { svc, getOne } = makeSvc({ rep: { id: 'r1', erpAccountCode: null } });
    expect(await svc.repErpStatementById('r1')).toEqual({ source: 'unavailable', reason: 'unlinked' });
    expect(getOne).not.toHaveBeenCalled();
  });

  it('says "erp_off" when the ERP connection is not set up', async () => {
    const { svc } = makeSvc({ rep: { id: 'r1', erpAccountCode: '1105-101' }, erpReady: false });
    expect(await svc.repErpStatementById('r1')).toEqual({ source: 'unavailable', reason: 'erp_off' });
  });

  it('says "not_found" and "fetch_failed" for the ERP not knowing the account, or not answering', async () => {
    const missing = makeSvc({ rep: { id: 'r1', erpAccountCode: 'X' }, getOne: jest.fn().mockResolvedValue(null) });
    expect(await missing.svc.repErpStatementById('r1')).toEqual({ source: 'unavailable', reason: 'not_found' });
    const down = makeSvc({ rep: { id: 'r1', erpAccountCode: 'X' }, getOne: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    expect(await down.svc.repErpStatementById('r1')).toEqual({ source: 'unavailable', reason: 'fetch_failed' });
  });
});
