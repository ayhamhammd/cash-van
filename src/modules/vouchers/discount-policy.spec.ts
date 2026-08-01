import { VouchersService } from './vouchers.service';
import type { CreateVoucherDto } from './dto/create-voucher.dto';

/**
 * Discounts are ungated by owner decision.
 *
 * Every case here used to throw: a salesman without `vouchers.discount.direct`
 * got DISCOUNT_NOT_ALLOWED, one with only `.approval` got
 * APPROVAL_REQUIRED:VOUCHER_DISCOUNT, and a `vouchers.discount.max:<n>` cap
 * bounced anything above it. They now pass, which is what keeps the discount on
 * the voucher and therefore in the ERP export.
 *
 * The RETURN gate is asserted alongside them to prove the ungating was surgical
 * and did not take the rest of the policy with it.
 */
interface Policy {
  enforceSalesmanPolicy(dto: CreateVoucherDto): Promise<void>;
  userCtx: { get(): { userId: string; role: string } | null };
  dataSource: unknown;
}

/** `permissions` are the keys stored on the salesman's user record. */
function policy(permissions: string[]): Policy {
  const svc = Object.create(VouchersService.prototype) as unknown as Policy;
  Object.defineProperty(svc, 'userCtx', {
    value: { get: () => ({ userId: 'u1', role: 'viewer' }) },
    configurable: true,
  });
  Object.defineProperty(svc, 'dataSource', {
    value: {
      getRepository: () => ({
        findOne: async () => ({ id: 'u1', userType: 'SALES', permissions }),
      }),
      // Only reached by the price-override check, which these fixtures skip.
      query: async () => [],
    },
    configurable: true,
  });
  return svc;
}

/** A SALE carrying a discount, expressed however the test needs. */
const sale = (over: Partial<CreateVoucherDto> = {}): CreateVoucherDto =>
  ({
    transKind: 'SALE',
    voucherNumber: 'V-1',
    userCode: '101',
    transactions: [
      { itemNumber: 'I-1', itemQty: '10', unitPrice: '10.000', discountValue: '20.000' },
    ],
    ...over,
  }) as CreateVoucherDto;

// Price-override is granted throughout so section 3 never runs; these tests are
// about the discount gate only.
const PRICE = 'vouchers.priceOverride';

describe('enforceSalesmanPolicy — discounts are ungated', () => {
  it('allows a line discount from a salesman with NO discount permission', async () => {
    await expect(policy([PRICE]).enforceSalesmanPolicy(sale())).resolves.toBeUndefined();
  });

  it('no longer routes an approval-only salesman through a manager', async () => {
    await expect(
      policy([PRICE, 'vouchers.discount.approval']).enforceSalesmanPolicy(sale()),
    ).resolves.toBeUndefined();
  });

  it('ignores a stored max-% cap, even when wildly exceeded', async () => {
    await expect(
      policy([PRICE, 'vouchers.discount.max:5']).enforceSalesmanPolicy(
        // 100% off a 100.000 line — far past the 5% cap.
        sale({
          transactions: [
            { itemNumber: 'I-1', itemQty: '10', unitPrice: '10.000', discountPercentage: '100' },
          ],
        } as Partial<CreateVoucherDto>),
      ),
    ).resolves.toBeUndefined();
  });

  it('allows a header-level discount too', async () => {
    await expect(
      policy([PRICE]).enforceSalesmanPolicy(
        sale({
          transactions: [{ itemNumber: 'I-1', itemQty: '10', unitPrice: '10.000' }],
          totalDiscountValue: '50.000',
        } as Partial<CreateVoucherDto>),
      ),
    ).resolves.toBeUndefined();
  });

  it('still gates RETURN vouchers — the ungating was discount-only', async () => {
    await expect(
      policy([PRICE]).enforceSalesmanPolicy(
        sale({ transKind: 'RETURN' } as Partial<CreateVoucherDto>),
      ),
    ).rejects.toThrow('RETURN_NOT_ALLOWED');
  });

  it('still routes a return to approval when that flag is set', async () => {
    await expect(
      policy([PRICE, 'vouchers.return.approval']).enforceSalesmanPolicy(
        sale({ transKind: 'RETURN' } as Partial<CreateVoucherDto>),
      ),
    ).rejects.toThrow('APPROVAL_REQUIRED:RETURN_VOUCHER');
  });
});
