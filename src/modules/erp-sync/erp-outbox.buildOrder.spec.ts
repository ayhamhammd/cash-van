import { ErpOutboxService } from './erp-outbox.service';

/**
 * Unit tests for buildOrder() — the ORDER voucher → ERP sales-order payload.
 * Verifies the two fixes: the EXACT decimal quantity is sent (never rounded to an
 * integer) and each line carries the van's quoted price + discount, not the ERP
 * catalogue price. The service is built by hand with only the repos this method
 * touches mocked. Constructor arg order: erp, settings, cashAccounts, outbox,
 * idmap(4), headers(5), lines(6), ...
 */
function makeSvc(mocks: { idmap?: unknown; headers?: unknown; lines?: unknown }) {
  const args: unknown[] = new Array(12).fill(null);
  args[4] = mocks.idmap ?? null;
  args[5] = mocks.headers ?? null;
  args[6] = mocks.lines ?? null;
  return new (ErpOutboxService as unknown as new (...a: unknown[]) => ErpOutboxService)(
    ...args,
  );
}

type Line = {
  itemNumber: string;
  itemQty: string;
  unitPrice: string;
  discountPercentage: string;
};

const line = (
  itemNumber: string,
  itemQty: string,
  unitPrice: string,
  discountPercentage = '0',
): Line => ({ itemNumber, itemQty, unitPrice, discountPercentage });

function build(opts: {
  header?: unknown;
  lines?: Line[];
  custErpId?: string | null;
  items?: Record<string, string>;
}) {
  const items = opts.items ?? {};
  const idmap = {
    findOne: jest.fn(({ where }: { where: { entity: string; localId: string } }) => {
      if (where.entity === 'customer') {
        const id = opts.custErpId === undefined ? 'cust-uuid' : opts.custErpId;
        return Promise.resolve(id ? { erpId: id } : null);
      }
      if (where.entity === 'item') {
        const id = items[where.localId];
        return Promise.resolve(id ? { erpId: id } : null);
      }
      return Promise.resolve(null);
    }),
  };
  const svc = makeSvc({
    idmap,
    headers: {
      findOne: jest
        .fn()
        .mockResolvedValue(opts.header ?? { voucherNumber: 'ORD-1', customerNumber: 'C-1' }),
    },
    lines: { find: jest.fn().mockResolvedValue(opts.lines ?? []) },
  });
  return (svc as unknown as { buildOrder(v: string): Promise<unknown> }).buildOrder('ORD-1');
}

describe('ErpOutboxService.buildOrder (ORDER → ERP sales order)', () => {
  it('sends the EXACT decimal quantity, never rounded to an integer', async () => {
    const call = await build({
      lines: [line('ITM-1', '2.5', '12.5', '5')],
      items: { 'ITM-1': 'sku-1' },
    });
    expect(call).toEqual({
      path: 'sales-orders',
      body: {
        customerId: 'cust-uuid',
        lines: [{ skuId: 'sku-1', quantity: 2.5, sellingPrice: 12.5, discountPercent: 5 }],
      },
    });
  });

  it('carries the van price + discount per line (not the catalogue price)', async () => {
    const call = (await build({
      lines: [line('A', '10', '3.25', '0'), line('B', '1', '100', '15')],
      items: { A: 'sku-a', B: 'sku-b' },
    })) as { body: { lines: unknown[] } };
    expect(call.body.lines).toEqual([
      { skuId: 'sku-a', quantity: 10, sellingPrice: 3.25, discountPercent: 0 },
      { skuId: 'sku-b', quantity: 1, sellingPrice: 100, discountPercent: 15 },
    ]);
  });

  it('retries (null) while the customer is not yet id-mapped', async () => {
    expect(
      await build({ custErpId: null, lines: [line('A', '1', '1')], items: { A: 'sku-a' } }),
    ).toBeNull();
  });

  it('retries (null) while an item is not yet id-mapped', async () => {
    expect(await build({ lines: [line('A', '1', '1')], items: {} })).toBeNull();
  });
});
