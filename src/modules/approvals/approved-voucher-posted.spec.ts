import { ApprovalsService } from './approvals.service';
import type { ApprovalRequest } from './entities/approval-request.entity';
import type { CreateVoucherDto } from '../vouchers/dto/create-voucher.dto';

/**
 * An approved request is a completed sale, and has to look like one.
 *
 * It used to be created as a draft: `vouchers.create` defaults `isPosted` to
 * false, the handset's encoder drops the field because `true` is its default, and
 * only the mobile sync path re-stamped it. So stock stayed in the van, the ERP
 * outbox — which enqueues only behind `header.isPosted` — never fired, and the
 * serial was keyed to the placeholder store 'NA'. A supervisor approved a sale
 * that, as far as every other system went, never happened.
 */
describe('ApprovalsService.approve — the voucher it creates', () => {
  interface Approver {
    approve: (id: string, reviewerUserId: string) => Promise<ApprovalRequest>;
  }

  const line = { itemNumber: '132', itemQty: '23.000', unitPrice: '1.333' };
  const freeLine = { ...line, itemQty: '1.000', isFree: true };

  function stored(overrides: Partial<ApprovalRequest> = {}) {
    return {
      id: 'a-1',
      type: 'VOUCHER_FREE_ITEM',
      status: 'pending',
      repId: 'rep-7',
      payload: { transKind: 'SALE', transactions: [line, freeLine] },
      ...overrides,
    } as unknown as ApprovalRequest;
  }

  /** Returns the service plus the DTO `vouchers.create` was handed. */
  function service(row: ApprovalRequest, vanStore: string | null = 'VAN-7') {
    const seen: CreateVoucherDto[] = [];
    const svc = Object.create(ApprovalsService.prototype) as unknown as Approver;
    const define = (name: string, value: unknown) =>
      Object.defineProperty(svc, name, { value, configurable: true });

    define('findOneOrThrow', () => Promise.resolve(row));
    define('vouchers', {
      create: (dto: CreateVoucherDto) => {
        seen.push(dto);
        return Promise.resolve({ voucherNumber: 'INV-VAN-7000001' });
      },
      resolveRepVanStore: () => Promise.resolve(vanStore),
    });
    define('repo', { save: (r: ApprovalRequest) => Promise.resolve(r) });
    define('notifyDecision', () => Promise.resolve());
    define('logger', { warn: () => undefined });
    return { svc, seen };
  }

  it('posts it, so stock moves and the ERP outbox is enqueued', async () => {
    const { svc, seen } = service(stored());
    await svc.approve('a-1', 'sup-1');
    expect(seen[0].isPosted).toBe(true);
  });

  it("stamps the rep's van store on lines that carry none", async () => {
    const { svc, seen } = service(stored());
    await svc.approve('a-1', 'sup-1');
    expect(seen[0].transactions.map((t) => t.storeNumber)).toEqual(['VAN-7', 'VAN-7']);
  });

  it('leaves a store the payload already named alone', async () => {
    const row = stored({
      payload: {
        transKind: 'SALE',
        transactions: [{ ...line, storeNumber: 'VAN-2' }],
      },
    } as unknown as Partial<ApprovalRequest>);
    const { svc, seen } = service(row);
    await svc.approve('a-1', 'sup-1');
    expect(seen[0].transactions[0].storeNumber).toBe('VAN-2');
  });

  it("falls back to 'NA' when the rep has no van, as sync does", async () => {
    const { svc, seen } = service(stored(), null);
    await svc.approve('a-1', 'sup-1');
    expect(seen[0].transactions[0].storeNumber).toBe('NA');
  });

  it('does not mutate the stored payload while promoting it', async () => {
    const row = stored();
    const { svc } = service(row);
    await svc.approve('a-1', 'sup-1');
    const payload = row.payload as unknown as CreateVoucherDto;
    expect(payload.isPosted).toBeUndefined();
    expect(payload.transactions[0].storeNumber).toBeUndefined();
  });

  it('records the approval against the created voucher', async () => {
    const row = stored();
    const { svc } = service(row);
    const out = await svc.approve('a-1', 'sup-1');
    expect(out.status).toBe('approved');
    expect(out.resultVoucher).toBe('INV-VAN-7000001');
  });

  it('promotes a discount request the same way — it was a draft too', async () => {
    const { svc, seen } = service(stored({ type: 'VOUCHER_DISCOUNT' } as Partial<ApprovalRequest>));
    await svc.approve('a-1', 'sup-1');
    expect(seen[0].isPosted).toBe(true);
  });
});
