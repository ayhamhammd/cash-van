import { ErpOutboxService, quotedPrice } from './erp-outbox.service';

/**
 * An order for a tax-exempt customer reaches the ERP at the price the salesman
 * quoted — tax included — and the ERP applies the exemption itself.
 *
 * cash-van stores an exempt order's prices with the tax already taken out
 * (1.160 → 1.000). Sending that stored price had the ERP take the tax out again:
 * its order read 1.000 as tax-inclusive, and the invoice raised from it applied
 * the exemption on top, billing 0.862 for a 1.000 item.
 *
 * Constructor order: erp, settings(1), …, idmap(4), headers(5), lines(6), …,
 * itemCarts(16).
 */
function build(opts: {
  header: Record<string, unknown>;
  lines: Array<{ itemNumber: string; itemQty: string; unitPrice: string; discountPercentage: string }>;
  taxCalcMethod?: 'INCLUSIVE' | 'EXCLUSIVE';
  items?: Array<{ itemNumber: string; taxType: string; taxPercentage: string; taxRate: string }>;
}) {
  const args: unknown[] = new Array(17).fill(null);
  args[1] = { get: jest.fn().mockResolvedValue({ taxCalcMethod: opts.taxCalcMethod ?? 'INCLUSIVE' }) };
  args[4] = {
    findOne: jest.fn(({ where }: { where: { entity: string; localId: string } }) =>
      Promise.resolve({
        erpId: where.entity === 'customer' ? '5f1c2d3e-0000-4000-8000-00000000c001' : `${where.entity}-${where.localId}`,
      }),
    ),
  };
  args[5] = { findOne: jest.fn().mockResolvedValue({ voucherNumber: 'ORD-1', customerNumber: 'C-1', ...opts.header }) };
  args[6] = { find: jest.fn().mockResolvedValue(opts.lines) };
  const itemCarts = { find: jest.fn().mockResolvedValue(opts.items ?? []) };
  args[16] = itemCarts;
  const svc = new (ErpOutboxService as unknown as new (...a: unknown[]) => ErpOutboxService)(...args);
  const run = (svc as unknown as { buildOrder(v: string): Promise<{ body: { lines: Array<{ sellingPrice: number }> } }> })
    .buildOrder('ORD-1');
  return { run, itemCarts };
}

const item16 = { itemNumber: 'A', taxType: 'TAXABLE', taxPercentage: '16', taxRate: '0.16' };
const line = (unitPrice: string) => ({ itemNumber: 'A', itemQty: '2', unitPrice, discountPercentage: '0' });

describe('ErpOutboxService.buildOrder — tax-exempt customer', () => {
  it('sends the quoted, tax-inclusive price so the ERP takes the tax out once', async () => {
    // 1.160 quoted, stored as 1.000 after the exemption.
    const { run } = build({ header: { isTaxExempt: true }, lines: [line('1.000')], items: [item16] });
    expect((await run).body.lines[0].sellingPrice).toBe(1.16);
  });

  it('reads the rate from the item, not the line — the exempt line was stored at 0%', async () => {
    const synced = { itemNumber: 'A', taxType: 'TAXABLE', taxPercentage: '0', taxRate: '0.16' };
    const { run } = build({ header: { isTaxExempt: true }, lines: [line('5.202')], items: [synced] });
    expect((await run).body.lines[0].sellingPrice).toBe(6.034);
  });

  it('leaves the price alone when it was never stripped', async () => {
    const notExempt = build({ header: { isTaxExempt: false }, lines: [line('1.160')], items: [item16] });
    expect((await notExempt.run).body.lines[0].sellingPrice).toBe(1.16);
    expect(notExempt.itemCarts.find).not.toHaveBeenCalled();

    // Exclusive prices never held tax, so there was nothing to strip.
    const exclusive = build({ header: { isTaxExempt: true }, lines: [line('1.000')], items: [item16], taxCalcMethod: 'EXCLUSIVE' });
    expect((await exclusive.run).body.lines[0].sellingPrice).toBe(1);
  });

  it('leaves an item with no tax, or an EXEMPT item, at its stored price', async () => {
    const zero = { itemNumber: 'A', taxType: 'EXEMPT', taxPercentage: '16', taxRate: '0.16' };
    const { run } = build({ header: { isTaxExempt: true }, lines: [line('3.500')], items: [zero] });
    expect((await run).body.lines[0].sellingPrice).toBe(3.5);
  });
});

describe('quotedPrice', () => {
  it('rebuilds the quoted price, and the ERP strip lands back on the stored net', () => {
    for (const quoted of [0.25, 1, 1.16, 2.35, 6.034, 12.999, 99.99]) {
      const stored = Number((quoted / 1.16).toFixed(3));
      const rebuilt = quotedPrice(stored, 16);
      expect(Math.abs(Math.round(rebuilt * 1000) - Math.round(quoted * 1000))).toBeLessThanOrEqual(1);
      expect(Number((rebuilt / 1.16).toFixed(3))).toBe(stored);
    }
  });
});
