import { ConflictException, BadRequestException } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import type { ApprovalRequest } from './entities/approval-request.entity';

/**
 * A supervisor may cut a requested giveaway. They may not do anything else.
 *
 * `approve` executes the stored payload verbatim - that is what makes an approval
 * mean something. Amendment has to hold the same line from the other side: "one
 * free, not five" is the whole power, and repricing the paid lines on the way past
 * is a different one that nobody asked for and that would arrive unaudited.
 */
describe('ApprovalsService.amendPayload', () => {
  interface Amender {
    amendPayload: (
      id: string,
      payload: Record<string, unknown>,
      reviewerUserId: string,
      reviewer?: undefined,
    ) => Promise<ApprovalRequest>;
  }

  const paid = { itemNumber: '132', itemQty: '23.000', unitPrice: '1.333', unitCode: 'PC' };
  const free = { itemNumber: '132', itemQty: '5.000', unitPrice: '1.333', unitCode: 'PC', isFree: true };

  function stored(overrides: Partial<ApprovalRequest> = {}) {
    return {
      id: 'a-1',
      type: 'VOUCHER_FREE_ITEM',
      status: 'pending',
      repId: null,
      payload: { customerNumber: 'CUST-1', transactions: [paid, free] },
      originalPayload: null,
      amendmentNote: null,
      ...overrides,
    } as unknown as ApprovalRequest;
  }

  function service(row: ApprovalRequest) {
    const saved: ApprovalRequest[] = [];
    const svc = Object.create(ApprovalsService.prototype) as unknown as Amender;
    Object.defineProperty(svc, 'findOneOrThrow', {
      value: () => Promise.resolve(row),
      configurable: true,
    });
    Object.defineProperty(svc, 'repo', {
      value: { save: (r: ApprovalRequest) => { saved.push(r); return Promise.resolve(r); } },
      configurable: true,
    });
    return { svc, saved };
  }

  /** The same payload with the free line re-quantified. */
  function amendedTo(qty: string) {
    return { customerNumber: 'CUST-1', transactions: [paid, { ...free, itemQty: qty }] };
  }

  it('accepts a cut to the free quantity and records both numbers', async () => {
    const row = stored();
    const { svc, saved } = service(row);
    await svc.amendPayload('a-1', amendedTo('1.000'), 'sup-1');
    expect(saved).toHaveLength(1);
    expect(saved[0].amendmentNote).toContain('5.000');
    expect(saved[0].amendmentNote).toContain('1.000');
    // What the rep asked for survives the edit.
    expect((saved[0].originalPayload as { transactions: unknown[] }).transactions[1]).toMatchObject({
      itemQty: '5.000',
    });
  });

  it('drops the line entirely when the free quantity is reversed to zero', async () => {
    const row = stored();
    const { svc, saved } = service(row);
    await svc.amendPayload('a-1', amendedTo('0'), 'sup-1');
    const txns = (saved[0].payload as { transactions: unknown[] }).transactions;
    // The paid line survives; the giveaway does not reach the ERP as a zero row.
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ itemQty: '23.000' });
  });

  it('REFUSES a change to a paid line quantity', async () => {
    const row = stored();
    const { svc } = service(row);
    const sneaky = {
      customerNumber: 'CUST-1',
      transactions: [{ ...paid, itemQty: '99.000' }, { ...free, itemQty: '1.000' }],
    };
    await expect(svc.amendPayload('a-1', sneaky, 'sup-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REFUSES a repriced free line - the supervisor agrees a quantity, not a price', async () => {
    const row = stored();
    const { svc } = service(row);
    const sneaky = {
      customerNumber: 'CUST-1',
      transactions: [paid, { ...free, itemQty: '1.000', unitPrice: '99.000' }],
    };
    await expect(svc.amendPayload('a-1', sneaky, 'sup-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REFUSES a changed customer', async () => {
    const row = stored();
    const { svc } = service(row);
    const sneaky = { customerNumber: 'CUST-OTHER', transactions: [paid, { ...free, itemQty: '1.000' }] };
    await expect(svc.amendPayload('a-1', sneaky, 'sup-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REFUSES added or removed lines', async () => {
    const row = stored();
    const { svc } = service(row);
    const sneaky = { customerNumber: 'CUST-1', transactions: [paid] };
    await expect(svc.amendPayload('a-1', sneaky, 'sup-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REFUSES a request that is already decided', async () => {
    const row = stored({ status: 'approved' } as Partial<ApprovalRequest>);
    const { svc } = service(row);
    await expect(svc.amendPayload('a-1', amendedTo('1.000'), 'sup-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('REFUSES a type that is not negotiable', async () => {
    // A discount or a return is approved as filed; only a giveaway is negotiable.
    const row = stored({ type: 'VOUCHER_DISCOUNT' } as Partial<ApprovalRequest>);
    const { svc } = service(row);
    await expect(svc.amendPayload('a-1', amendedTo('1.000'), 'sup-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('REFUSES a no-op, so an empty edit cannot look like a decision', async () => {
    const row = stored();
    const { svc } = service(row);
    await expect(svc.amendPayload('a-1', amendedTo('5.000'), 'sup-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('keeps the FIRST original across a second amendment', async () => {
    const row = stored();
    const { svc, saved } = service(row);
    await svc.amendPayload('a-1', amendedTo('3.000'), 'sup-1');
    row.payload = amendedTo('3.000');
    await svc.amendPayload('a-1', amendedTo('1.000'), 'sup-2');
    expect((saved[1].originalPayload as { transactions: Array<{ itemQty: string }> }).transactions[1].itemQty)
      .toBe('5.000');
  });
});
