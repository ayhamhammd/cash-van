import { ErpOutboxService } from './erp-outbox.service';

/**
 * An approved over-limit sale carries its approval to the ERP.
 *
 * Both systems enforce the credit limit, and only one of them knows a
 * supervisor said yes. Before this, an approved sale was pushed as an ordinary
 * credit sale, the ERP re-ran its own check and refused it with
 * CREDIT_LIMIT_EXCEEDED, and the invoice sat in the outbox for ever — goods
 * gone from the van, nothing in the accounts. Neither side was wrong; the sale
 * fell down the gap between them.
 *
 * Constructor arg order: erp, settings, cashAccounts, outbox, idmap(4),
 * headers(5), lines(6), tobaccoProfiles(7), collections, customers,
 * salesmanSettlements, payments(11), …, itemCarts(16), approvals(17), users(18).
 */
function buildSale(approval: unknown, reviewer: unknown = null) {
  const args: any[] = new Array(19).fill(null);
  args[5] = {
    findOne: jest.fn().mockResolvedValue({
      voucherNumber: 'S-1',
      userCode: '101',
      customerNumber: 'CUST-1',
      inDate: '2026-01-01',
    }),
  };
  args[6] = { find: jest.fn().mockResolvedValue([]) };
  args[11] = { find: jest.fn().mockResolvedValue([]) }; // no payment rows → on-account
  args[17] = { findOne: jest.fn().mockResolvedValue(approval) };
  args[18] = { findOne: jest.fn().mockResolvedValue(reviewer) };
  const svc = new (ErpOutboxService as any)(...args) as any;
  svc.customerRef = jest.fn().mockResolvedValue({ customerCode: 'CUST-1' });
  svc.vanStoreOf = jest.fn().mockReturnValue('VAN-1');
  return { svc, promise: svc.buildSale('S-1') as Promise<{ body: Record<string, any> }> };
}

const approved = {
  id: 'appr-7',
  type: 'CREDIT_OVER_LIMIT',
  status: 'approved',
  resultVoucher: 'S-1',
  reviewerUser: 'user-9',
  decisionNote: 'pays Thursday',
};

describe('a sale approved past the credit limit', () => {
  it('carries the approval to the ERP', async () => {
    const { promise } = buildSale(approved, { id: 'user-9', name: 'محمد طلعت' });
    const { body } = await promise;
    expect(body.creditOverride).toEqual({
      approvalRef: 'appr-7',
      approvedBy: 'محمد طلعت',
      reason: 'pays Thursday',
    });
  });

  it('sends the approval id, because the ERP uses it to not double-record', async () => {
    // The outbox retries until the ERP accepts. One decision must produce one
    // exception however many attempts it took, and the approval id is the only
    // thing stable across them.
    const { promise } = buildSale(approved, { id: 'user-9', name: 'محمد طلعت' });
    const { body } = await promise;
    expect(body.creditOverride.approvalRef).toBe('appr-7');
  });

  it('sends the approver by NAME, not by uuid', async () => {
    // Read by whoever audits credit decisions in the ERP, where a VanFlow user
    // id means nothing at all.
    const { promise } = buildSale(approved, { id: 'user-9', name: 'عزت' });
    const { body } = await promise;
    expect(body.creditOverride.approvedBy).toBe('عزت');
  });

  it('falls back to the reviewer id when the user row is gone', async () => {
    const { promise } = buildSale(approved, null);
    const { body } = await promise;
    expect(body.creditOverride.approvedBy).toBe('user-9');
  });

  it('sends no override for an ordinary sale', async () => {
    const { promise } = buildSale(null);
    const { body } = await promise;
    expect(body).not.toHaveProperty('creditOverride');
  });

  it('asks only for an APPROVED request of this type', async () => {
    // A discount or price-override approval authorises something else entirely
    // and must not double as permission to exceed a credit limit.
    const args: any[] = new Array(19).fill(null);
    args[5] = { findOne: jest.fn().mockResolvedValue({ voucherNumber: 'S-1', userCode: '101', customerNumber: 'CUST-1', inDate: '2026-01-01' }) };
    args[6] = { find: jest.fn().mockResolvedValue([]) };
    args[11] = { find: jest.fn().mockResolvedValue([]) };
    const findOne = jest.fn().mockResolvedValue(null);
    args[17] = { findOne };
    args[18] = { findOne: jest.fn().mockResolvedValue(null) };
    const svc = new (ErpOutboxService as any)(...args) as any;
    svc.customerRef = jest.fn().mockResolvedValue({ customerCode: 'CUST-1' });
    svc.vanStoreOf = jest.fn().mockReturnValue('VAN-1');
    await svc.buildSale('S-1');
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type: 'CREDIT_OVER_LIMIT', status: 'approved', resultVoucher: 'S-1' },
      }),
    );
  });

  it('still builds the sale when the approvals lookup fails', async () => {
    // A push that dies because the override lookup threw would be worse than
    // one that goes without it: the ERP would simply apply its ordinary rules.
    const args: any[] = new Array(19).fill(null);
    args[5] = { findOne: jest.fn().mockResolvedValue({ voucherNumber: 'S-1', userCode: '101', customerNumber: 'CUST-1', inDate: '2026-01-01' }) };
    args[6] = { find: jest.fn().mockResolvedValue([]) };
    args[11] = { find: jest.fn().mockResolvedValue([]) };
    args[17] = { findOne: jest.fn().mockRejectedValue(new Error('db down')) };
    args[18] = { findOne: jest.fn().mockResolvedValue(null) };
    const svc = new (ErpOutboxService as any)(...args) as any;
    svc.customerRef = jest.fn().mockResolvedValue({ customerCode: 'CUST-1' });
    svc.vanStoreOf = jest.fn().mockReturnValue('VAN-1');
    const { body } = await svc.buildSale('S-1');
    expect(body).not.toHaveProperty('creditOverride');
    expect(body.externalId).toBe('S-1');
  });
});
