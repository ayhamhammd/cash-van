import { ForbiddenException } from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import type { CreateVoucherDto } from './dto/create-voucher.dto';

/**
 * Visa (CARD) payments need the salesman's `canUseCardPayment`. An online sale
 * without it is refused; managers, admins and internal calls are not gated.
 * (Offline sales arriving through sync skip this and alert the managers.)
 */
interface Gate {
  enforceCardPermission(dto: CreateVoucherDto): Promise<void>;
  userMayTakeCard(userCode: string | null | undefined): Promise<boolean>;
}

function gate(
  user: { userType?: string; canUseCardPayment?: boolean } | null,
  role: string | null = 'viewer',
): Gate {
  const svc = Object.create(VouchersService.prototype) as unknown as Gate;
  Object.defineProperty(svc, 'userCtx', {
    value: { get: () => (role ? { userId: 'u1', role } : null) },
  });
  Object.defineProperty(svc, 'dataSource', {
    value: {
      getRepository: () => ({
        findOne: async () => (user ? { id: 'u1', userType: 'SALES', ...user } : null),
      }),
    },
  });
  return svc;
}

const sale = (paymentType: string): CreateVoucherDto =>
  ({
    transKind: 'SALE',
    userCode: '101',
    transactions: [],
    payments: [{ paymentType, amount: '10.000' }],
  }) as unknown as CreateVoucherDto;

describe('Visa payment permission', () => {
  it('refuses a Visa sale from a salesman without the permission', async () => {
    await expect(
      gate({ canUseCardPayment: false }).enforceCardPermission(sale('CARD')),
    ).rejects.toThrow(new ForbiddenException('CARD_NOT_ALLOWED'));
  });

  it('allows a Visa sale from a permitted salesman', async () => {
    await expect(
      gate({ canUseCardPayment: true }).enforceCardPermission(sale('CARD')),
    ).resolves.toBeUndefined();
  });

  it('does not gate cash or credit', async () => {
    const g = gate({ canUseCardPayment: false });
    await expect(g.enforceCardPermission(sale('CASH'))).resolves.toBeUndefined();
    await expect(g.enforceCardPermission(sale('CREDIT'))).resolves.toBeUndefined();
  });

  it('does not gate managers, admins or internal calls', async () => {
    await expect(
      gate({ canUseCardPayment: false }, 'manager').enforceCardPermission(sale('CARD')),
    ).resolves.toBeUndefined();
    await expect(
      gate({ canUseCardPayment: false, userType: 'ADMIN' }).enforceCardPermission(sale('CARD')),
    ).resolves.toBeUndefined();
    await expect(
      gate({ canUseCardPayment: false }, null).enforceCardPermission(sale('CARD')),
    ).resolves.toBeUndefined();
  });

  it('userMayTakeCard reads the salesman behind the voucher', async () => {
    expect(await gate({ canUseCardPayment: false }).userMayTakeCard('101')).toBe(false);
    expect(await gate({ canUseCardPayment: true }).userMayTakeCard('101')).toBe(true);
    expect(await gate(null).userMayTakeCard('101')).toBe(true);
    expect(await gate({ canUseCardPayment: false }).userMayTakeCard(null)).toBe(true);
  });
});
