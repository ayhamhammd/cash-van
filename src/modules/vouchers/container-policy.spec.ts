import { VouchersService } from './vouchers.service';
import type { CreateVoucherDto } from './dto/create-voucher.dto';
import type { ItemCart } from '../items/entities/item-cart.entity';

/**
 * The two guards that make `can_handle_containers` safe to hand out.
 *
 * Collecting empty buckets has no money in it and no approval step, which is
 * deliberate — routing it through a manager would make reps stop recording it,
 * and an unrecorded empty is worse than no feature. What stands in place of the
 * approval is this pair of checks:
 *
 *   1. the permission gate — only a rep who holds the flag may post at all
 *   2. the line check — a container document may name NOTHING but flagged
 *      container items, at zero price
 *
 * Without (2) the flag would be a way to move any product in the catalogue into
 * a van for free, with no manager ever seeing it. That is the test that matters
 * most in this file.
 */

// ── (1) the permission gate ──────────────────────────────────────────────────

interface Policy {
  enforceSalesmanPolicy(dto: CreateVoucherDto): Promise<void>;
  userCtx: { get(): { userId: string; role: string } | null };
  dataSource: unknown;
}

/** A salesman holding `permissions` keys, with `canHandleContainers` as given. */
function policy(permissions: string[], canHandleContainers = false): Policy {
  const svc = Object.create(VouchersService.prototype) as unknown as Policy;
  Object.defineProperty(svc, 'userCtx', {
    value: { get: () => ({ userId: 'u1', role: 'viewer' }) },
    configurable: true,
  });
  Object.defineProperty(svc, 'dataSource', {
    value: {
      getRepository: () => ({
        findOne: async () => ({
          id: 'u1',
          userType: 'SALES',
          permissions,
          canHandleContainers,
        }),
      }),
      query: async () => [],
    },
    configurable: true,
  });
  return svc;
}

/** A container document: one bucket line, zero price, as the app sends it. */
const containerIn = (over: Partial<CreateVoucherDto> = {}): CreateVoucherDto =>
  ({
    transKind: 'CONTAINER_IN',
    voucherNumber: 'CIN-1',
    userCode: '101',
    customerNumber: 'CUST-1',
    transactions: [{ itemNumber: 'BUCKET-6', itemQty: '3', unitPrice: '0.000' }],
    ...over,
  }) as CreateVoucherDto;

const PRICE = 'vouchers.priceOverride';

describe('container documents — the permission gate', () => {
  it('refuses a rep who holds neither the column nor the key', async () => {
    await expect(policy([PRICE]).enforceSalesmanPolicy(containerIn())).rejects.toThrow(
      'CONTAINERS_NOT_ALLOWED',
    );
  });

  it('allows a rep whose user record carries the permission', async () => {
    await expect(
      policy([PRICE], true).enforceSalesmanPolicy(containerIn()),
    ).resolves.toBeUndefined();
  });

  it('allows a rep granted the F10 key instead', async () => {
    await expect(
      policy([PRICE, 'vouchers.container.move']).enforceSalesmanPolicy(containerIn()),
    ).resolves.toBeUndefined();
  });

  it('gates CONTAINER_OUT the same way — lending crates is the same power', async () => {
    await expect(
      policy([PRICE]).enforceSalesmanPolicy(containerIn({ transKind: 'CONTAINER_OUT' })),
    ).rejects.toThrow('CONTAINERS_NOT_ALLOWED');
  });

  it('does NOT let the container permission authorise a goods RETURN', async () => {
    // The whole point of a separate flag: a rep who may collect empties has not
    // thereby been given the power to credit a customer for cheese.
    await expect(
      policy([PRICE], true).enforceSalesmanPolicy(containerIn({ transKind: 'RETURN' })),
    ).rejects.toThrow('RETURN_NOT_ALLOWED');
  });

  it('leaves an ordinary SALE untouched', async () => {
    await expect(
      policy([PRICE]).enforceSalesmanPolicy(
        containerIn({
          transKind: 'SALE',
          transactions: [{ itemNumber: 'I-1', itemQty: '1', unitPrice: '10.000' }],
        } as Partial<CreateVoucherDto>),
      ),
    ).resolves.toBeUndefined();
  });
});

// ── (2) the line check ───────────────────────────────────────────────────────

interface Lines {
  enforceContainerLines(dto: CreateVoucherDto, items: ItemCart[]): Promise<void>;
  settings: { containersEnabled(): Promise<boolean> };
}

function lines(enabled = true): Lines {
  const svc = Object.create(VouchersService.prototype) as unknown as Lines;
  Object.defineProperty(svc, 'settings', {
    value: { containersEnabled: async () => enabled },
    configurable: true,
  });
  return svc;
}

const item = (itemNumber: string, isReturnableContainer: boolean): ItemCart =>
  ({ itemNumber, isReturnableContainer }) as ItemCart;

const BUCKET = item('BUCKET-6', true);
const CHEESE = item('HALLOUMI-6', false);

describe('container documents — the line check', () => {
  it('accepts a flagged container at zero price', async () => {
    await expect(
      lines().enforceContainerLines(containerIn(), [BUCKET]),
    ).resolves.toBeUndefined();
  });

  it('REFUSES an ordinary product — the whole reason the flag is safe to grant', async () => {
    // Without this, `can_handle_containers` would move 3 × halloumi into the van
    // at no charge with no approval. This is the security case.
    await expect(
      lines().enforceContainerLines(
        containerIn({
          transactions: [{ itemNumber: 'HALLOUMI-6', itemQty: '3', unitPrice: '0.000' }],
        } as Partial<CreateVoucherDto>),
        [CHEESE],
      ),
    ).rejects.toThrow('NOT_A_CONTAINER');
  });

  it('refuses a document that mixes a container with a product', async () => {
    // Checked per line rather than "any line is a container", so one bucket
    // cannot carry a pallet of cheese through with it.
    await expect(
      lines().enforceContainerLines(
        containerIn({
          transactions: [
            { itemNumber: 'BUCKET-6', itemQty: '3', unitPrice: '0.000' },
            { itemNumber: 'HALLOUMI-6', itemQty: '10', unitPrice: '0.000' },
          ],
        } as Partial<CreateVoucherDto>),
        [BUCKET, CHEESE],
      ),
    ).rejects.toThrow('NOT_A_CONTAINER');
  });

  it('refuses a non-zero price rather than quietly zeroing it', async () => {
    // Zeroing would let a mispriced document post and look deliberate. The app
    // sends 0 for these, so anything else means something is wrong upstream.
    await expect(
      lines().enforceContainerLines(
        containerIn({
          transactions: [{ itemNumber: 'BUCKET-6', itemQty: '3', unitPrice: '1.500' }],
        } as Partial<CreateVoucherDto>),
        [BUCKET],
      ),
    ).rejects.toThrow('CONTAINER_PRICE_NOT_ZERO');
  });

  it('refuses an unknown item instead of treating it as a container', async () => {
    await expect(
      lines().enforceContainerLines(containerIn(), []),
    ).rejects.toThrow('not found');
  });

  it('refuses everything while the feature is switched off', async () => {
    // An installed APK that still offers the action must be told, not humoured:
    // otherwise a company that never asked for this accumulates packaging
    // movements nobody reads.
    await expect(
      lines(false).enforceContainerLines(containerIn(), [BUCKET]),
    ).rejects.toThrow('CONTAINERS_DISABLED');
  });
});
