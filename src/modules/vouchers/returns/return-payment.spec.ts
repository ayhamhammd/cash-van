import { asksForCash, classifyReturnPayment, returnPaymentMilli } from './return-payment';
import type { CreateVoucherDto } from '../dto/create-voucher.dto';

/**
 * A return is credit, unless a salesman the office allows chose cash
 * (docs/SPEC-cash-returns.md). These pin the intake rule.
 */
describe('classifyReturnPayment', () => {
  const dto = (transKind: string, payments?: Array<{ amount: string; paymentType: string; paymentDate?: string }>) =>
    ({ transKind, payments }) as unknown as CreateVoucherDto;

  it('keeps a cash return cash for a salesman allowed to refund cash', () => {
    const d = dto('RETURN', [{ amount: '12.500', paymentType: 'CASH' }]);
    expect(classifyReturnPayment(d, true)).toBe('CASH');
    expect(d.payments).toEqual([{ amount: '12.500', paymentType: 'CASH' }]);
  });

  it('turns a cash return into credit for anyone else — every old build included', () => {
    const d = dto('RETURN', [{ amount: '12.500', paymentType: 'CASH' }]);
    expect(classifyReturnPayment(d, false)).toBe('CREDIT');
    expect(d.payments).toEqual([{ amount: '12.500', paymentType: 'CREDIT' }]);
  });

  it('never refunds to Visa, even for an allowed salesman', () => {
    const d = dto('RETURN', [{ amount: '8.000', paymentType: 'CARD' }]);
    expect(classifyReturnPayment(d, true)).toBe('CREDIT');
  });

  it('keeps a credit return credit', () => {
    const d = dto('RETURN', [{ amount: '8.000', paymentType: 'CREDIT' }]);
    expect(classifyReturnPayment(d, true)).toBe('CREDIT');
  });

  it('merges a mixed split into one credit row of the exact sum', () => {
    const d = dto('RETURN', [
      { amount: '0.100', paymentType: 'CASH', paymentDate: '2026-09-25T10:00:00Z' },
      { amount: '0.200', paymentType: 'CREDIT' },
    ]);
    expect(classifyReturnPayment(d, true)).toBe('CREDIT');
    expect(d.payments).toEqual([{ amount: '0.300', paymentType: 'CREDIT', paymentDate: '2026-09-25T10:00:00Z' }]);
  });

  it('merges an all-cash split into one cash row', () => {
    const d = dto('RETURN', [
      { amount: '0.100', paymentType: 'CASH' },
      { amount: '0.200', paymentType: 'CASH' },
    ]);
    expect(classifyReturnPayment(d, true)).toBe('CASH');
    expect(d.payments).toEqual([{ amount: '0.300', paymentType: 'CASH' }]);
  });

  it('leaves a return with no payment rows alone', () => {
    const d = dto('RETURN');
    expect(classifyReturnPayment(d, true)).toBeNull();
    expect(d.payments).toBeUndefined();
  });

  it('never touches a sale — a cash sale stays cash', () => {
    const d = dto('SALE', [{ amount: '5.000', paymentType: 'CASH' }]);
    expect(classifyReturnPayment(d, false)).toBeNull();
    expect(d.payments?.[0].paymentType).toBe('CASH');
  });

  it('knows a cash request, and sums in thousandths', () => {
    expect(asksForCash(dto('RETURN', [{ amount: '1', paymentType: 'CASH' }]))).toBe(true);
    expect(asksForCash(dto('RETURN', [{ amount: '1', paymentType: 'CREDIT' }]))).toBe(false);
    expect(asksForCash(dto('SALE', [{ amount: '1', paymentType: 'CASH' }]))).toBe(false);
    expect(returnPaymentMilli(dto('RETURN', [{ amount: '0.1', paymentType: 'CASH' }, { amount: '0.2', paymentType: 'CASH' }]))).toBe(300);
  });
});
