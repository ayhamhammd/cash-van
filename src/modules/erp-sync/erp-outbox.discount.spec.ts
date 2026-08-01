import { ErpOutboxService } from './erp-outbox.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- hand-built service, see below */

/**
 * The discount must ALWAYS reach the ERP.
 *
 * Discounts are ungated on the way in (any salesman, any amount, no approval —
 * see vouchers/discount-policy.spec.ts), so the only remaining way one could go
 * missing is the outbound invoice payload. `voucher_transactions.discount_value`
 * already carries the line discount PLUS that line's share of any header-level
 * discount, so a single per-line `discount` field is the whole picture.
 *
 * Constructor arg order: erp, settings, cashAccounts, outbox, idmap(4),
 * headers(5), lines(6), tobaccoProfiles(7), collections, customers,
 * salesmanSettlements, payments(11).
 */
function makeSvc(mocks: { headers?: any; lines?: any; payments?: any; customers?: any }) {
  const args: any[] = new Array(12).fill(null);
  args[5] = mocks.headers;
  args[6] = mocks.lines;
  args[7] = { findOne: jest.fn().mockResolvedValue({ erpId: 'erp-profile-1' }) };
  args[9] = mocks.customers ?? { findOne: jest.fn().mockResolvedValue(null) };
  args[11] = mocks.payments;
  return new (ErpOutboxService as any)(...args) as ErpOutboxService;
}

type Line = Record<string, unknown>;

const buildSale = (lines: Line[]) => {
  const svc = makeSvc({
    headers: {
      findOne: jest.fn().mockResolvedValue({
        voucherNumber: 'S-1',
        userCode: '101',
        customerNumber: 'CUST-1',
        inDate: '2026-01-01',
      }),
    },
    lines: { find: jest.fn().mockResolvedValue(lines) },
    // Fully-paid cash sale, so the ERP books it as an immediate payment.
    payments: {
      find: jest.fn().mockResolvedValue([
        { voucherNumber: 'S-1', amount: '100.000', paymentType: 'CASH' },
      ]),
    },
  }) as any;
  // taxRateId resolution hits the settings/ERP path these fixtures don't wire.
  svc.taxRateIdForPct = jest.fn().mockResolvedValue(undefined);
  svc.customerRef = jest.fn().mockResolvedValue({ customerCode: 'CUST-1' });
  svc.vanStoreOf = jest.fn().mockReturnValue('VAN-1');
  return svc.buildSale('S-1') as Promise<{ body: Record<string, unknown> }>;
};

const line = (over: Line = {}): Line => ({
  itemNumber: 'SKU-1',
  itemQty: '10',
  unitPrice: '10.000',
  discountValue: '0',
  taxPercentage: '16',
  unitBaseQty: 1,
  isTobaccoLine: false,
  ...over,
});

describe('buildSale — discount always exported', () => {
  it('sends the line discount on the invoice item', async () => {
    const { body } = await buildSale([line({ discountValue: '12.500' })]);
    expect((body.items as Line[])[0]).toMatchObject({
      skuCode: 'SKU-1',
      quantity: 10,
      unitPrice: 10,
      discount: 12.5,
    });
  });

  it('sends 0 rather than omitting the field when there is no discount', async () => {
    const { body } = await buildSale([line()]);
    const item = (body.items as Line[])[0];
    expect(item).toHaveProperty('discount', 0);
  });

  it('exports a discount on every line independently', async () => {
    const { body } = await buildSale([
      line({ itemNumber: 'A', discountValue: '1.000' }),
      line({ itemNumber: 'B', discountValue: '0' }),
      line({ itemNumber: 'C', discountValue: '7.250' }),
    ]);
    expect((body.items as Line[]).map((i) => i.discount)).toEqual([1, 0, 7.25]);
  });

  it('keeps the discount as a LINE TOTAL while unitPrice is divided to per-piece', async () => {
    // A case of 12: quantity is in base pieces, unitPrice is per piece, but the
    // discount stays the whole-line amount — dividing it would understate it 12x.
    const { body } = await buildSale([
      line({ itemQty: '24', unitPrice: '120.000', unitBaseQty: 12, discountValue: '6.000' }),
    ]);
    expect((body.items as Line[])[0]).toMatchObject({
      quantity: 24,
      unitPrice: 10, // 120.000 / 12
      discount: 6, // NOT 0.5
    });
  });

  it('exports the discount on a tobacco line too', async () => {
    const svcLine = line({
      isTobaccoLine: true,
      tobaccoTaxProfileId: 'p1',
      consumerPriceFils: 3000,
      discountValue: '4.000',
    });
    const { body } = await buildSale([svcLine]);
    expect((body.items as Line[])[0]).toMatchObject({
      isTobaccoLine: true,
      discount: 4,
    });
  });

  it.each([['abc'], [null], [undefined]])(
    'coerces an unusable discountValue (%s) to 0 instead of NaN',
    async (bad) => {
      const { body } = await buildSale([line({ discountValue: bad })]);
      expect((body.items as Line[])[0].discount).toBe(0);
    },
  );
});

/**
 * The ERP's item schema is `quantity: z.number().int().positive()`, but van
 * lines are numeric(14,3). Rounding to satisfy it would make the van invoice and
 * the ERP invoice disagree on what was sold, so the push fails with a message
 * naming the item instead of the ERP's opaque 400.
 */
describe('buildSale — quantity must satisfy the ERP schema', () => {
  it('passes a whole quantity straight through', async () => {
    const { body } = await buildSale([line({ itemQty: '7' })]);
    expect((body.items as Line[])[0].quantity).toBe(7);
  });

  it('accepts a trailing-zero decimal as the whole number it is', async () => {
    const { body } = await buildSale([line({ itemQty: '3.000' })]);
    expect((body.items as Line[])[0].quantity).toBe(3);
  });

  it('refuses a fractional quantity rather than rounding it', async () => {
    await expect(buildSale([line({ itemQty: '2.5' })])).rejects.toThrow(
      /fractional quantity 2\.5.*whole units/s,
    );
  });

  it('names the offending item so the error is actionable', async () => {
    await expect(
      buildSale([line({ itemNumber: 'SKU-ODD', itemQty: '1.25' })]),
    ).rejects.toThrow(/SKU-ODD/);
  });

  it.each([['0'], ['-1'], ['abc'], [null]])('refuses non-positive quantity %s', async (q) => {
    await expect(buildSale([line({ itemQty: q })])).rejects.toThrow(/positive quantity/);
  });
});
