import { ErpSyncService } from './erp-sync.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- hand-built service, as in erp-sync.reconcile.spec.ts */

/**
 * A PATCH that carries nothing must not be sent.
 *
 * `JSON.stringify` drops undefined values, so a body assembled as
 * `{ name: p.name, phone: p.phone }` with both undefined leaves this process as
 * `{}`. The ERP reads that as "you asked me to update a record and named no
 * field", and answers VALIDATION_ERROR: No updatable fields provided — which
 * then appears in the log as a failed sync, every time a settings screen is
 * saved without touching anything the ERP mirrors.
 *
 * Nothing was broken on the ERP's side: refusing an empty patch is right. The
 * bug was sending one.
 */
describe('ERP patch bodies are never empty', () => {
  // Constructor arg order is documented in erp-sync.reconcile.spec.ts; only
  // erp(0) and settings(1) are reached here.
  const makeService = () => {
    const patch = jest.fn().mockResolvedValue(undefined);
    const args: any[] = new Array(23).fill(null);
    args[0] = { patch };
    args[1] = {
      getErpConfig: jest.fn().mockResolvedValue({ enabled: true, baseUrl: 'x', apiKey: 'y' }),
    };
    const svc = new (ErpSyncService as any)(...args) as ErpSyncService;
    (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
    return { svc, patch };
  };

  describe('organization', () => {
    it('sends nothing when the event carries no name and no mirrored field', async () => {
      const { svc, patch } = makeService();
      // The shape that produced the bug: JSON.stringify turns this into `{}`.
      await svc.onSettingsUpdated({ name: undefined as never, salesTaxMode: 'EXCLUSIVE' });
      expect(patch).not.toHaveBeenCalled();
    });

    it('sends nothing when the name is blank', async () => {
      const { svc, patch } = makeService();
      // A blank name would fail the ERP's own min(1) as a validation error
      // instead, which is a different message for the same non-event.
      await svc.onSettingsUpdated({ name: '', salesTaxMode: 'EXCLUSIVE' });
      expect(patch).not.toHaveBeenCalled();
    });

    it('still sends a real change', async () => {
      const { svc, patch } = makeService();
      await svc.onSettingsUpdated({ name: 'Ferdous', salesTaxMode: 'EXCLUSIVE' });
      expect(patch).toHaveBeenCalledWith('organization', { name: 'Ferdous' });
    });

    it('never pushes the tax mode back — the ERP masters it', async () => {
      const { svc, patch } = makeService();
      await svc.onSettingsUpdated({ name: 'Ferdous', salesTaxMode: 'INCLUSIVE' });
      expect(patch.mock.calls[0][1]).not.toHaveProperty('salesTaxMode');
    });

    it('carries a cleared field, because null is a value and undefined is not', async () => {
      const { svc, patch } = makeService();
      await svc.onSettingsUpdated({
        name: 'Ferdous',
        salesTaxMode: 'EXCLUSIVE',
        address: null,
      });
      expect(patch).toHaveBeenCalledWith('organization', { name: 'Ferdous', address: null });
    });
  });
});
