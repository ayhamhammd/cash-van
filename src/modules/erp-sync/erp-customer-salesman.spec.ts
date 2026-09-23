import { Logger } from '@nestjs/common';

import { ErpOutboxService } from './erp-outbox.service';
import { ErpSyncService } from './erp-sync.service';
import { erpCustomerBody, erpWarnings } from './erp-customer-payload';

/**
 * A customer goes to the ERP with his salesman.
 *
 * The rep's code IS the ERP salesman code — the same identity his van warehouse
 * and every receipt already carry — so that is what is sent, as `salesmanCode`.
 * Two paths send a customer (the immediate push and the outbox retry); both
 * must, or whether a customer arrives assigned would depend on whether the ERP
 * happened to be up when he was created.
 */

describe('erpCustomerBody', () => {
  it('sends the rep code as salesmanCode', () => {
    expect(erpCustomerBody({ code: 'C1', name: 'Shop', repCode: '101' })).toEqual({
      code: 'C1', name: 'Shop', salesmanCode: '101',
    });
  });

  it('sends no salesmanCode at all when there is no rep — not null, not ""', () => {
    for (const repCode of [null, undefined, '', '   ']) {
      expect(erpCustomerBody({ code: 'C1', name: 'Shop', repCode })).not.toHaveProperty('salesmanCode');
    }
  });

  it('keeps every other field as it was', () => {
    expect(erpCustomerBody({
      code: 'C1', name: 'Shop', phone: '0790000000', email: 'a@b.jo',
      taxNumber: 'TN', creditLimit: 150, repCode: ' 101 ',
    })).toEqual({
      code: 'C1', name: 'Shop', phone: '0790000000', email: 'a@b.jo',
      taxNumber: 'TN', creditLimit: 150, salesmanCode: '101',
    });
  });
});

describe('erpWarnings', () => {
  it('reads the ERP warnings, and nothing that is not one', () => {
    expect(erpWarnings({ warnings: ['created unassigned', 7] })).toEqual(['created unassigned']);
    expect(erpWarnings({ data: {} })).toEqual([]);
    expect(erpWarnings(null)).toEqual([]);
  });
});

describe('ErpOutboxService.buildCustomer — the retry path', () => {
  // Arg order: erp, settings, cashAccounts, outbox, idmap(4), headers(5),
  // lines(6), tobaccoProfiles, collections(8), customers(9), salesmanSettlements,
  // payments(11), itemUnits, stockRequests, reps(14), cheques(15).
  function build(customer: Record<string, unknown>, rep: unknown) {
    const args: unknown[] = new Array(16).fill(null);
    args[9] = { findOne: jest.fn().mockResolvedValue(customer) };
    args[14] = { findOne: jest.fn().mockResolvedValue(rep) };
    const svc = new (ErpOutboxService as unknown as new (...a: unknown[]) => ErpOutboxService)(...args);
    return (svc as unknown as {
      buildCustomer(ref: string): Promise<{ path: string; body: Record<string, unknown> } | null>;
    }).buildCustomer(customer.customerNumber as string);
  }

  it('names the salesman when the customer has a rep', async () => {
    const out = await build({ customerNumber: 'C1', customerName: 'Shop', repId: 'rep-1' }, { id: 'rep-1', code: '101' });
    expect(out?.path).toBe('customers');
    expect(out?.body).toMatchObject({ code: 'C1', salesmanCode: '101' });
  });

  it('sends the customer unassigned when he has none', async () => {
    const out = await build({ customerNumber: 'C2', customerName: 'Shop', repId: null }, null);
    expect(out?.body).not.toHaveProperty('salesmanCode');
  });
});

describe('ErpSyncService.pushCustomer — the immediate path', () => {
  function makeSvc(rep: unknown, response: { ok: boolean; data?: unknown; error?: string }) {
    const svc = Object.create(ErpSyncService.prototype) as Record<string, unknown>;
    const post = jest.fn().mockResolvedValue(response);
    const warn = jest.fn();
    svc.settings = { getErpConfig: async () => ({ enabled: true, baseUrl: 'http://erp', apiKey: 'k' }) };
    svc.erp = { post };
    svc.reps = { findOne: jest.fn().mockResolvedValue(rep) };
    svc.upsertIdMap = jest.fn();
    svc.outbox = { enqueue: jest.fn() };
    svc.logger = Object.assign(new Logger('test'), { warn });
    return { svc: svc as unknown as ErpSyncService, post, warn };
  }

  it('sends the rep code the event named', async () => {
    const { svc, post } = makeSvc({ id: 'rep-1', code: '101' }, { ok: true, data: { data: { id: 'erp-1' } } });
    await svc.onCustomerCreated({ code: 'C1', name: 'Shop', repId: 'rep-1' });
    expect(post).toHaveBeenCalledWith('customers', expect.objectContaining({ code: 'C1', salesmanCode: '101' }), 'C1');
  });

  it('says so in the log when the ERP could not assign him — and does not retry', async () => {
    const { svc, warn } = makeSvc(
      { id: 'rep-1', code: '999' },
      { ok: true, data: { data: { id: 'erp-1' }, warnings: ['Salesman Code "999" was not found. The customer was created unassigned.'] } },
    );
    await svc.onCustomerCreated({ code: 'C1', name: 'Shop', repId: 'rep-1' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('created unassigned'));
    expect((svc as unknown as { outbox: { enqueue: jest.Mock } }).outbox.enqueue).not.toHaveBeenCalled();
  });

  it('a customer with no rep goes without a salesman, and without a lookup', async () => {
    const { svc, post } = makeSvc(null, { ok: true, data: { data: { id: 'erp-2' } } });
    await svc.onCustomerCreated({ code: 'C2', name: 'Shop' });
    expect(post.mock.calls[0][1]).not.toHaveProperty('salesmanCode');
    expect((svc as unknown as { reps: { findOne: jest.Mock } }).reps.findOne).not.toHaveBeenCalled();
  });
});
