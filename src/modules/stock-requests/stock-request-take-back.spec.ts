import { ConflictException } from '@nestjs/common';

import { StockRequestsService } from './stock-requests.service';
import type { StockRequest } from './entities/stock-request.entity';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * An approved request can be taken back — rejected or deleted — until the goods
 * are received. Approval moves no stock, so up to receipt there is nothing to
 * contradict; after it there is a transfer voucher, and the request is its
 * paperwork.
 *
 * Taking it back must not erase who approved it (the report reads approvedBy),
 * and must tell the salesman, who was about to go and collect it.
 */
describe('StockRequestsService — taking back an approval before receipt', () => {
  const admin = { sub: 'boss', role: 'admin', userType: 'ADMIN' } as AuthenticatedUser;
  const clerk = { sub: 'clerk', role: 'admin', userType: 'ADMIN' } as AuthenticatedUser;

  function request(over: Partial<StockRequest> = {}): StockRequest {
    return {
      id: 'req-1',
      requestNumber: 'SR-000001',
      status: 'pending',
      requesterUser: 'salesman',
      repId: null,
      vanStoreNumber: 'V1',
      sourceStoreNumber: null,
      transferVoucherNumber: null,
      reviewerUser: null,
      approvedBy: null,
      approvedAt: null,
      decisionNote: null,
      decidedAt: null,
      items: [
        { id: 'line-1', itemNumber: 'A', itemName: 'A', stockUnitCode: '', baseQty: '5', approvedBaseQty: null },
      ],
      ...over,
    } as unknown as StockRequest;
  }

  function makeSvc(row: StockRequest) {
    const svc = Object.create(StockRequestsService.prototype) as Record<string, unknown>;
    const notified: Array<{ to: string; titleEn: string; bodyEn?: string }> = [];
    const softDeleted: string[] = [];
    svc.repo = {
      findOne: async () => row,
      save: async (r: StockRequest) => r,
      softDelete: async (id: string) => softDeleted.push(id),
    };
    svc.repScope = { assertCanSeeRep: async () => undefined };
    svc.notifications = {
      notifyUser: async (to: string, n: { titleEn: string; bodyEn?: string }) =>
        notified.push({ to, ...n }),
    };
    svc.events = { emit: jest.fn() };
    svc.warehouses = { findOne: async () => ({ whNumber: 'W1', whName: 'Main' }) };
    svc.warehouseQtyByPool = async () => new Map([['A|', 100]]);
    svc.dataSource = { transaction: async (fn: (m: unknown) => unknown) => fn({ save: async () => undefined }) };
    svc.erpOutbox = { enqueue: jest.fn() };
    return { svc: svc as unknown as StockRequestsService, notified, softDeleted };
  }

  it('approving records the approver separately from the last decision', async () => {
    const row = request();
    const { svc } = makeSvc(row);
    await svc.approve(row.id, { sourceStoreNumber: 'W1' }, admin);
    expect(row.status).toBe('approved');
    expect(row.approvedBy).toBe('boss');
    expect(row.approvedAt).toBeInstanceOf(Date);
    expect(row.reviewerUser).toBe('boss');
  });

  it('rejects an approved request that has not been received, keeping the approver', async () => {
    const row = request({
      status: 'approved', reviewerUser: 'boss', approvedBy: 'boss', approvedAt: new Date('2026-03-01'),
      sourceStoreNumber: 'W1',
    });
    const { svc, notified } = makeSvc(row);
    await svc.reject(row.id, 'Warehouse is short this week', clerk);
    expect(row.status).toBe('rejected');
    expect(row.reviewerUser).toBe('clerk');
    expect(row.approvedBy).toBe('boss');
    expect(row.decisionNote).toBe('Warehouse is short this week');
    // The salesman hears it, with the reason.
    expect(notified).toEqual([
      expect.objectContaining({ to: 'salesman', bodyEn: 'Warehouse is short this week' }),
    ]);
    expect(notified[0].titleEn).toMatch(/rejected/);
  });

  it('still rejects a pending request', async () => {
    const row = request();
    const { svc } = makeSvc(row);
    await svc.reject(row.id, 'No', admin);
    expect(row.status).toBe('rejected');
    expect(row.approvedBy).toBeNull();
  });

  it('refuses to reject once the goods were received', async () => {
    const received = request({ status: 'received', transferVoucherNumber: 'TR-9', approvedBy: 'boss' });
    await expect(makeSvc(received).svc.reject(received.id, 'late', admin)).rejects.toThrow(
      ConflictException,
    );
    // Approved, but the office already attached the transfer that filled it.
    const filled = request({ status: 'approved', transferVoucherNumber: 'TR-10' });
    await expect(makeSvc(filled).svc.reject(filled.id, 'late', admin)).rejects.toThrow(
      /already received on voucher TR-10/,
    );
  });

  it('refuses to reject a request that is already rejected or cancelled', async () => {
    for (const status of ['rejected', 'cancelled'] as const) {
      const row = request({ status });
      await expect(makeSvc(row).svc.reject(row.id, 'again', admin)).rejects.toThrow(ConflictException);
    }
  });

  it('deletes an approved request that has not been received, and tells the salesman', async () => {
    const row = request({ status: 'approved', approvedBy: 'boss' });
    const { svc, notified, softDeleted } = makeSvc(row);
    await svc.softDelete(row.id, admin);
    expect(softDeleted).toEqual(['req-1']);
    expect(notified).toEqual([expect.objectContaining({ to: 'salesman' })]);
    expect(notified[0].titleEn).toMatch(/deleted after approval/);
  });

  it('deleting a rejected request stays quiet — the salesman was told at rejection', async () => {
    const row = request({ status: 'rejected' });
    const { svc, notified, softDeleted } = makeSvc(row);
    await svc.softDelete(row.id, admin);
    expect(softDeleted).toEqual(['req-1']);
    expect(notified).toEqual([]);
  });

  it('never deletes a received request or a pending one', async () => {
    const received = request({ status: 'received', transferVoucherNumber: 'TR-9' });
    await expect(makeSvc(received).svc.softDelete(received.id, admin)).rejects.toThrow(ConflictException);
    const pending = request();
    await expect(makeSvc(pending).svc.softDelete(pending.id, admin)).rejects.toThrow(ConflictException);
  });
});
