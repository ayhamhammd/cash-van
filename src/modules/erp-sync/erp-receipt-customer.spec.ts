import { ErpSyncService } from './erp-sync.service';

/**
 * Which cash-van customer a receipt pulled from the ERP belongs to.
 *
 * THE BUG THIS PINS. The feed was matched on `customerCode` alone, and an ERP
 * customer's code is optional — one created in the ERP usually has none, so
 * cash-van derives its own `ERP-<uuid-prefix>` number just to key on. The
 * receipt then matched nobody and was dropped: the rep's collection never
 * appeared, and the customer's local ledger stayed short by money they had
 * actually handed over. The ERP's statement showed it; the van's did not.
 *
 * The id-map holds the ERP's real id, which is what the push path has always
 * used. These say the pull path uses it too — and that the code still works,
 * because a customer that has one may not be mapped yet on a first sync.
 */
describe('receiptCustomer — matching a pulled receipt to a customer', () => {
  type Receipt = { id: string; customerId?: string | null; customerCode: string | null };
  type Customer = { id: string; customerNumber: string; repId: string | null };

  /**
   * The service with only the two repositories this method touches.
   *
   * `idmap` answers on (entity, erpId); `customers` answers on customerNumber.
   * Anything else returns null, which is what makes an unmatched receipt show
   * up here as null rather than as a wrong customer.
   */
  function makeSvc(world: {
    map?: { erpId: string; localId: string };
    customers?: Customer[];
  }) {
    const svc = Object.create(ErpSyncService.prototype) as Record<string, unknown>;
    svc.idmap = {
      findOne: async ({ where }: { where: { entity: string; erpId: string } }) =>
        world.map && where.entity === 'customer' && where.erpId === world.map.erpId
          ? world.map
          : null,
    };
    svc.customers = {
      findOne: async ({ where }: { where: { customerNumber: string } }) =>
        (world.customers ?? []).find((c) => c.customerNumber === where.customerNumber) ?? null,
    };
    return svc as unknown as {
      receiptCustomer(r: Receipt): Promise<Customer | null>;
    };
  }

  const shop = (customerNumber: string, repId: string | null = 'rep-1'): Customer => ({
    id: `local-${customerNumber}`,
    customerNumber,
    repId,
  });

  it('finds the customer by the ERP id when the receipt carries no code', async () => {
    // The whole bug: this receipt used to be skipped.
    const svc = makeSvc({
      map: { erpId: 'erp-uuid-1', localId: 'ERP-2798694a' },
      customers: [shop('ERP-2798694a')],
    });
    const found = await svc.receiptCustomer({
      id: 'r1', customerId: 'erp-uuid-1', customerCode: null,
    });
    expect(found?.customerNumber).toBe('ERP-2798694a');
  });

  it('still matches on the code for a customer not yet in the id-map', async () => {
    // A first sync pulls receipts before every customer has been mapped.
    const svc = makeSvc({ customers: [shop('CUST-000103')] });
    const found = await svc.receiptCustomer({
      id: 'r2', customerId: 'erp-uuid-9', customerCode: 'CUST-000103',
    });
    expect(found?.customerNumber).toBe('CUST-000103');
  });

  it('prefers the id over the code when the two disagree', async () => {
    // The code is a value this side invented for some customers, so it can
    // collide with a real one. The id cannot.
    const svc = makeSvc({
      map: { erpId: 'erp-uuid-1', localId: 'ERP-2798694a' },
      customers: [shop('ERP-2798694a'), shop('CUST-000103')],
    });
    const found = await svc.receiptCustomer({
      id: 'r3', customerId: 'erp-uuid-1', customerCode: 'CUST-000103',
    });
    expect(found?.customerNumber).toBe('ERP-2798694a');
  });

  it('falls back to the code when the id is mapped to a customer this side no longer has', async () => {
    const svc = makeSvc({
      map: { erpId: 'erp-uuid-1', localId: 'ERP-deleted' },
      customers: [shop('CUST-000103')],
    });
    const found = await svc.receiptCustomer({
      id: 'r4', customerId: 'erp-uuid-1', customerCode: 'CUST-000103',
    });
    expect(found?.customerNumber).toBe('CUST-000103');
  });

  it('matches nobody when the receipt names neither a known id nor a known code', async () => {
    // Deliberately null rather than a guess: a collection attributed to the
    // wrong shop is worse than one that waits for the customer to sync.
    const svc = makeSvc({ customers: [shop('CUST-000103')] });
    expect(await svc.receiptCustomer({ id: 'r5', customerId: null, customerCode: null }))
      .toBeNull();
    expect(await svc.receiptCustomer({ id: 'r6', customerId: 'unknown', customerCode: 'NOPE' }))
      .toBeNull();
  });
});
