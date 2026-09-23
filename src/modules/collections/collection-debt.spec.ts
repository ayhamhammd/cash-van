import { CollectionsService } from './collections.service';

/**
 * A receipt has to reduce what the customer owes, the moment it is accepted.
 *
 * VouchersService.applyCreditVoucherToDebt already moves total_debt when a credit
 * sale posts. Collections had no equivalent, so between ERP syncs the balance only
 * ever went UP: a rep took money and the customer still showed the full debt.
 *
 * On the handset that meant leaving a customer and coming back before a credit sale
 * would be accepted - the device had counted the collection, then the server's
 * untouched figure overwrote it and the credit headroom collapsed.
 */
describe('CollectionsService.applyCollectionToDebt', () => {
  interface Debt {
    applyCollectionToDebt: (em: unknown, customerId: string, amountFils: number) => Promise<void>;
  }

  function service() {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const svc = Object.create(CollectionsService.prototype) as unknown as Debt;
    const em = { query: (sql: string, params: unknown[]) => { queries.push({ sql, params }); return Promise.resolve(); } };
    return { svc, em, queries };
  }

  it('converts fils to major units - the thousandfold trap', async () => {
    // Collections are stored in FILS, total_debt in major units. Subtracting the
    // raw fils would move the balance a thousand times too far.
    const { svc, em, queries } = service();
    await svc.applyCollectionToDebt(em, 'cust-1', 50_000);
    expect(queries[0].params[1]).toBe('50.00');
  });

  it('keeps the fils that JOD actually has', async () => {
    const { svc, em, queries } = service();
    await svc.applyCollectionToDebt(em, 'cust-1', 9_331);
    expect(queries[0].params[1]).toBe('9.33');
  });

  it('SUBTRACTS - a receipt reduces the debt', async () => {
    const { svc, em, queries } = service();
    await svc.applyCollectionToDebt(em, 'cust-1', 1_000);
    expect(queries[0].sql).toContain('-');
    expect(queries[0].sql).toContain('total_debt');
  });

  it('does NOT clamp at zero, so a customer can be in credit', async () => {
    // The whole point. Collect 100 against a debt of 30 and the customer is 70 in
    // credit; GREATEST(0, ...) would delete that 70 - money they have handed over.
    // It is also what the credit-sale headroom is computed from.
    const { svc, em, queries } = service();
    await svc.applyCollectionToDebt(em, 'cust-1', 100_000);
    expect(queries[0].sql).not.toContain('GREATEST');
  });

  it('is a single statement, not a read-modify-write', async () => {
    // Two receipts for one customer at once would otherwise both read the old
    // balance and one would overwrite the other.
    const { svc, em, queries } = service();
    await svc.applyCollectionToDebt(em, 'cust-1', 1_000);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('COALESCE(total_debt, 0)');
  });

  it('does nothing for a zero amount or a missing customer', async () => {
    const { svc, em, queries } = service();
    await svc.applyCollectionToDebt(em, 'cust-1', 0);
    await svc.applyCollectionToDebt(em, '', 1_000);
    expect(queries).toHaveLength(0);
  });
});
