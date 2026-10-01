import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

import { ApprovalsService } from './approvals.service';
import { VouchersService } from '../vouchers/vouchers.service';
import type { ApprovalRequest } from './entities/approval-request.entity';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { CreateVoucherDto } from '../vouchers/dto/create-voucher.dto';

/**
 * A salesman asks a supervisor to let a credit sale go past the customer's limit.
 * Approving it creates the invoice with ONLY the limit check skipped; refusing it
 * leaves nothing behind (the phone keeps the cart).
 */
type Svc = Record<string, unknown> & {
  approve: (id: string, reviewerUserId: string, reviewer?: AuthenticatedUser) => Promise<ApprovalRequest>;
};

function bare(): Svc {
  return Object.create(ApprovalsService.prototype) as unknown as Svc;
}
const define = (svc: object, name: string, value: unknown) =>
  Object.defineProperty(svc, name, { value, configurable: true });

const sale = {
  transKind: 'SALE',
  customerNumber: 'C-9',
  transactions: [{ itemNumber: '132', itemQty: '10.000', unitPrice: '5.000' }],
  payments: [{ paymentType: 'CREDIT', amount: '50.000' }],
};

describe('CREDIT_OVER_LIMIT — approving', () => {
  function service(type: string) {
    const opts: unknown[] = [];
    const svc = bare();
    const row = { id: 'a-1', type, status: 'pending', repId: 'rep-7', payload: sale } as unknown as ApprovalRequest;
    define(svc, 'findOneOrThrow', () => Promise.resolve(row));
    define(svc, 'vouchers', {
      create: (_dto: CreateVoucherDto, o: unknown) => {
        opts.push(o);
        return Promise.resolve({ voucherNumber: 'INV-VAN-7000009' });
      },
      resolveRepVanStore: () => Promise.resolve('VAN-7'),
    });
    define(svc, 'repo', { save: (r: ApprovalRequest) => Promise.resolve(r) });
    define(svc, 'notifyDecision', () => Promise.resolve());
    define(svc, 'logger', { warn: () => undefined });
    define(svc, 'repScope', { assertCanSeeRep: () => Promise.resolve() });
    return { svc, opts, row };
  }

  it('creates the invoice with the credit-limit check skipped', async () => {
    const { svc, opts } = service('CREDIT_OVER_LIMIT');
    const row = await svc.approve('a-1', 'sup-1');
    expect(opts[0]).toEqual({ allowOverCreditLimit: true });
    expect(row.status).toBe('approved');
    expect(row.resultVoucher).toBe('INV-VAN-7000009');
  });

  it('keeps the limit check for every other kind of request', async () => {
    const { svc, opts } = service('VOUCHER_FREE_ITEM');
    await svc.approve('a-1', 'mgr-1');
    expect(opts[0]).toEqual({ allowOverCreditLimit: false });
  });

  it('lets a supervisor decide it for their own salesmen', async () => {
    const { svc } = service('CREDIT_OVER_LIMIT');
    const sup = { sub: 'sup-1', role: 'supervisor' } as AuthenticatedUser;
    await expect(svc.approve('a-1', 'sup-1', sup)).resolves.toMatchObject({ status: 'approved' });
  });

  it('still keeps a supervisor away from money requests that are not credit', async () => {
    const { svc } = service('VOUCHER_DISCOUNT');
    const sup = { sub: 'sup-1', role: 'supervisor' } as AuthenticatedUser;
    await expect(svc.approve('a-1', 'sup-1', sup)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('CREDIT_OVER_LIMIT — filing', () => {
  type Ctx = (r: unknown, n: string | null, p: Record<string, unknown>) => Promise<Record<string, unknown>>;
  function context(customer: Record<string, unknown> | null) {
    const svc = bare();
    define(svc, 'customerRows', { findOne: () => Promise.resolve(customer) });
    return (svc as unknown as { creditContext: Ctx }).creditContext.bind(svc);
  }
  const rep = { role: 'salesman', permissions: ['vouchers.credit.request'] };
  const shop = { customerName: 'Shop', nameAr: 'محل', creditLimit: '100.000', totalDebt: '80.000', creditHold: false };

  it('freezes the figures the supervisor decides on', async () => {
    const ctx = await context(shop)(rep, 'C-9', sale);
    expect(ctx).toEqual({
      customerName: 'محل', creditLimit: 100, balance: 80, creditAmount: 50,
      available: 20, overBy: 30, creditHold: false,
    });
  });

  it('refuses a salesman who was not given the permission', async () => {
    await expect(context(shop)({ role: 'salesman', permissions: [] }, 'C-9', sale))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a request with no credit in it', async () => {
    const cash = { ...sale, payments: [{ paymentType: 'CASH', amount: '50.000' }] };
    await expect(context(shop)(rep, 'C-9', cash)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('VouchersService credit guard with an approval', () => {
  type Guard = (dto: unknown, allowOverLimit?: boolean) => Promise<void>;
  function guard(customer: Record<string, unknown>) {
    const svc = Object.create(VouchersService.prototype) as Record<string, unknown>;
    define(svc, 'dataSource', { getRepository: () => ({ findOne: () => Promise.resolve(customer) }) });
    return (svc as unknown as { enforceCreditLimit: Guard }).enforceCreditLimit.bind(svc);
  }
  const dto = { transKind: 'SALE', customerNumber: 'C-9', payments: [{ paymentType: 'CREDIT', amount: 50 }] };
  const over = { customerName: 'Shop', creditLimit: '100', totalDebt: '80', creditHold: false };

  it('blocks the sale without an approval', async () => {
    await expect(guard(over)(dto)).rejects.toBeInstanceOf(ConflictException);
  });

  it('lets an approved sale past the limit', async () => {
    await expect(guard(over)(dto, true)).resolves.toBeUndefined();
  });

  it('never lets an approval past a credit hold', async () => {
    await expect(guard({ ...over, creditHold: true })(dto, true)).rejects.toBeInstanceOf(ConflictException);
  });
});
