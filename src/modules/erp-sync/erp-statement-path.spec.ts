import { ErpSyncService } from './erp-sync.service';

/**
 * Which ERP endpoint a customer's statement is fetched from.
 *
 * THE BUG THIS PINS. An ERP customer's `code` is optional, and one created in
 * the ERP commonly has none — cash-van then derives its own `ERP-<uuid-prefix>`
 * number just to have something to key on. Asking the ERP for a statement under
 * that derived number is asking for a code it has never held: it answers 404,
 * the fetch returns null, and the van app shows a shopkeeper "unavailable /
 * not_found" where their account should be.
 *
 * The id-map holds the ERP's real id for exactly this case and the outbox has
 * always used it when pushing. These say the read path must use it too.
 */
describe('getErpCustomerStatement — which path it asks for', () => {
  /** The service with only the two things this method touches. */
  function makeSvc(): { svc: ErpSyncService; paths: string[] } {
    const paths: string[] = [];
    const svc = Object.create(ErpSyncService.prototype) as Record<string, unknown>;
    svc.settings = {
      getErpConfig: async () => ({ enabled: true, baseUrl: 'http://erp', apiKey: 'k' }),
    };
    svc.erp = {
      getOne: async (path: string) => {
        paths.push(path);
        return { customerId: 'x' };
      },
    };
    return { svc: svc as unknown as ErpSyncService, paths };
  }

  const call = (
    code: string,
    range: { from?: string; to?: string },
    erpId?: string | null,
  ) => {
    const { svc, paths } = makeSvc();
    return (svc as unknown as {
      getErpCustomerStatement(
        c: string,
        r: { from?: string; to?: string },
        e?: string | null,
      ): Promise<unknown>;
    })
      .getErpCustomerStatement(code, range, erpId)
      .then(() => paths);
  };

  it('asks by ID when the id-map knows the ERP customer', async () => {
    const paths = await call('ERP-685cf412', {}, '664129dd-4349-4be6-a0ca-ad1ce86002aa');
    expect(paths[0]).toBe('customers/664129dd-4349-4be6-a0ca-ad1ce86002aa/statement');
  });

  it('never asks by a DERIVED number — the ERP has never held one', async () => {
    // `ERP-…` is cash-van's own invention for a customer the ERP gave no code.
    // Sending it as a code is the 404 this exists to stop.
    const paths = await call('ERP-685cf412', {}, '664129dd-4349-4be6-a0ca-ad1ce86002aa');
    expect(paths[0]).not.toContain('ERP-685cf412');
    expect(paths[0]).not.toContain('by-code');
  });

  it('falls back to the code when there is no mapped id', async () => {
    // A customer that originated HERE has a real code and may not be mapped yet.
    const paths = await call('C-1001', {}, null);
    expect(paths[0]).toBe('customers/by-code/C-1001/statement');
  });

  it('carries the date window either way', async () => {
    const byId = await call('X', { from: '2026-09-01', to: '2026-09-12' }, 'the-id');
    expect(byId[0]).toBe('customers/the-id/statement?from=2026-09-01&to=2026-09-12');

    const byCode = await call('C-2', { from: '2026-09-01', to: '2026-09-12' }, null);
    expect(byCode[0]).toBe('customers/by-code/C-2/statement?from=2026-09-01&to=2026-09-12');
  });

  it('asks for nothing when it has neither identifier', async () => {
    expect(await call('', {}, null)).toEqual([]);
  });

  it('escapes an identifier that would otherwise break the path', async () => {
    const paths = await call('C/1 2', {}, null);
    expect(paths[0]).toBe('customers/by-code/C%2F1%202/statement');
  });
});
