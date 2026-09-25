import { returnsAreCredit } from './returns-are-credit';
import type { CreateVoucherDto } from '../dto/create-voucher.dto';

/**
 * A return is the customer's credit — never a cash refund. These pin the intake
 * rule that makes every RETURN a CREDIT payment, whatever an old phone sent.
 */
describe('returnsAreCredit', () => {
  const dto = (transKind: string, payments?: Array<{ amount: string; paymentType: string; paymentDate?: string }>) =>
    ({ transKind, payments }) as unknown as CreateVoucherDto;

  it('turns a cash refund into the customer’s credit, amount untouched', () => {
    const d = dto('RETURN', [{ amount: '12.500', paymentType: 'CASH' }]);
    returnsAreCredit(d);
    expect(d.payments).toEqual([{ amount: '12.500', paymentType: 'CREDIT' }]);
  });

  it('does the same for a return of a Visa sale', () => {
    const d = dto('RETURN', [{ amount: '8.000', paymentType: 'CARD' }]);
    returnsAreCredit(d);
    expect(d.payments?.[0].paymentType).toBe('CREDIT');
  });

  it('merges a split into one credit row of the exact sum', () => {
    const d = dto('RETURN', [
      { amount: '0.100', paymentType: 'CASH', paymentDate: '2026-09-25T10:00:00Z' },
      { amount: '0.200', paymentType: 'CREDIT' },
    ]);
    returnsAreCredit(d);
    expect(d.payments).toEqual([{ amount: '0.300', paymentType: 'CREDIT', paymentDate: '2026-09-25T10:00:00Z' }]);
  });

  it('leaves a return with no payment rows alone', () => {
    const d = dto('RETURN');
    returnsAreCredit(d);
    expect(d.payments).toBeUndefined();
  });

  it('never touches a sale — a cash sale stays cash', () => {
    const d = dto('SALE', [{ amount: '5.000', paymentType: 'CASH' }]);
    returnsAreCredit(d);
    expect(d.payments?.[0].paymentType).toBe('CASH');
  });
});
