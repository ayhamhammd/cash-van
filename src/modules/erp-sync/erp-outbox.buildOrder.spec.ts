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
  storeNumber?: string | null;
};

const line = (
  itemNumber: string,
  itemQty: string,
  unitPrice: string,
  discountPercentage = '0',
  storeNumber?: string | null,
): Line => ({ itemNumber, itemQty, unitPrice, discountPercentage, storeNumber });

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
  /**
   * Which van took the order.
   *
   * The van store, the salesman code and the ERP warehouse code are one shared
   * identity, so the code is the whole of what the other side needs to attribute
   * the order — and it is the only form this side holds. An order that reaches
   * the ERP without it belongs to no van, and every van order used to.
   */
  describe('vanWarehouseCode', () => {
    const body = async (opts: Parameters<typeof build>[0]) =>
      ((await build(opts)) as { body: Record<string, unknown> }).body;

    it("carries the store the order's own lines were taken from", async () => {
      expect(
        await body({
          lines: [line('A', '1', '1', '0', 'VAN-07')],
          items: { A: 'sku-a' },
        }),
      ).toMatchObject({ vanWarehouseCode: 'VAN-07' });
    });

    it('falls back to the salesman who raised it when a line names no store', async () => {
      // The van store IS the salesman code, so this is the same van either way —
      // it is a fallback in shape only.
      expect(
        await body({
          header: { voucherNumber: 'ORD-1', customerNumber: 'C-1', userCode: 'SM-42' },
          lines: [line('A', '1', '1')],
          items: { A: 'sku-a' },
        }),
      ).toMatchObject({ vanWarehouseCode: 'SM-42' });
    });

    it("prefers the line's own store over the salesman's code", async () => {
      expect(
        await body({
          header: { voucherNumber: 'ORD-1', customerNumber: 'C-1', userCode: 'SM-42' },
          lines: [line('A', '1', '1', '0', 'VAN-07')],
          items: { A: 'sku-a' },
        }),
      ).toMatchObject({ vanWarehouseCode: 'VAN-07' });
    });

    it('is left out entirely when no van can be named', async () => {
      // Absent, not blank. A key holding "" would have to be handled by the far
      // side, and an order with no van is exactly the body that was sent before
      // this field existed.
      const b = await body({ lines: [line('A', '1', '1')], items: { A: 'sku-a' } });
      expect('vanWarehouseCode' in b).toBe(false);
    });

    it('leaves the rest of the order untouched', async () => {
      expect(
        await body({
          header: { voucherNumber: 'ORD-1', customerNumber: 'C-1', userCode: 'SM-42' },
          lines: [line('A', '2.5', '3.25', '5', 'VAN-07')],
          items: { A: 'sku-a' },
        }),
      ).toEqual({
        customerId: 'cust-uuid',
        vanWarehouseCode: 'VAN-07',
        lines: [{ skuId: 'sku-a', quantity: 2.5, sellingPrice: 3.25, discountPercent: 5 }],
      });
    });
  });

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
