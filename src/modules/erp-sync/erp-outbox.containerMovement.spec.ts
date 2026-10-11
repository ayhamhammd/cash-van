import { ErpOutboxService } from './erp-outbox.service';

/**
 * A container document on its way to the ERP's packaging ledger.
 *
 * The movement is NOT a stock adjustment, although it looks like one and moves
 * van stock like one: the ERP has to record WHICH CUSTOMER is holding the
 * empties, and `stock_adjustments` has no customer column. That is the whole
 * reason `container-movements` exists on the ERP side, and the reason these
 * assertions care about `customerCode` at all.
 *
 * The other invariant here is that no money travels. A returnable container has
 * no value: the ERP must not raise a credit note, a journal or a tax line for
 * one, so the body carries quantities and nothing else.
 */
type Built = { path: string; body: Record<string, unknown> } | null;

function makeSvc(
  header: Record<string, unknown> | null,
  lines: Array<Record<string, unknown>> = [{ itemNumber: 'BUCKET-6', itemQty: '3.000' }],
) {
  // Positional construction, like the other builders' specs: 5 = headers,
  // 6 = lines (see the constructor).
  const args: unknown[] = new Array(17).fill(null);
  args[5] = { findOne: jest.fn().mockResolvedValue(header) };
  args[6] = { find: jest.fn().mockResolvedValue(lines) };
  const svc = new (ErpOutboxService as unknown as new (...a: unknown[]) => unknown)(
    ...args,
  ) as Record<string, unknown>;
  svc.erpSkuResolver = jest
    .fn()
    .mockResolvedValue((l: { itemNumber: string }) => `ERP-${l.itemNumber}`);
  svc.vanStoreOf = jest.fn().mockReturnValue('VAN-1');
  svc.logger = { warn: jest.fn(), log: jest.fn(), debug: jest.fn() };
  return {
    build: () =>
      (
        svc as unknown as { buildContainerMovement(v: string): Promise<Built> }
      ).buildContainerMovement('CIN-1'),
    warn: (svc.logger as { warn: jest.Mock }).warn,
  };
}

const header = (over: Record<string, unknown> = {}) => ({
  voucherNumber: 'CIN-1',
  transKind: 'CONTAINER_IN',
  customerNumber: 'CUST-1',
  userCode: '101',
  inDate: new Date('2026-03-04T08:30:00.000Z'),
  ...over,
});

describe('a container movement on its way to the ERP', () => {
  it('posts to the container ledger, not to stock-adjustments', async () => {
    const { build } = makeSvc(header());
    const built = await build();
    expect(built?.path).toBe('container-movements');
  });

  it('names the customer holding the packaging — the reason this endpoint exists', async () => {
    const { build } = makeSvc(header());
    const built = await build();
    expect(built?.body.customerCode).toBe('CUST-1');
    expect(built?.body.salesmanCode).toBe('101');
    expect(built?.body.warehouseCode).toBe('VAN-1');
  });

  it('carries the voucher number as externalId, which is what makes a retry idempotent', async () => {
    const { build } = makeSvc(header());
    const built = await build();
    expect(built?.body.externalId).toBe('CIN-1');
  });

  it('sends the direction rather than a sign, one kind for both documents', async () => {
    const back = await makeSvc(header()).build();
    expect(back?.body.direction).toBe('IN');

    const lent = await makeSvc(header({ transKind: 'CONTAINER_OUT' })).build();
    expect(lent?.body.direction).toBe('OUT');
  });

  it('sends quantities and no money at all', async () => {
    // An empty bucket has no value. If anything money-shaped reached the ERP it
    // could raise a credit note, a journal or a tax line for a container — the
    // one thing this whole feature must never do.
    const { build } = makeSvc(header());
    const built = await build();
    expect(built?.body.items).toEqual([{ skuCode: 'ERP-BUCKET-6', quantity: 3 }]);
    expect(JSON.stringify(built?.body)).not.toMatch(/price|amount|total|tax|discount|payment/i);
  });

  it('dates the movement from the document, not from when the sweep ran', async () => {
    const { build } = makeSvc(header());
    const built = await build();
    expect(built?.body.movedAt).toBe('2026-03-04T08:30:00.000Z');
  });

  it('drops a movement with no customer instead of retrying it forever', async () => {
    // There is nothing the ERP could usefully record, and no amount of retrying
    // supplies a customer — so this returns null (dropped) rather than throwing.
    const { build, warn } = makeSvc(header({ customerNumber: null }));
    expect(await build()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('builds nothing from a voucher that is gone, or one with no lines', async () => {
    expect(await makeSvc(null).build()).toBeNull();
    expect(await makeSvc(header(), []).build()).toBeNull();
  });
});
