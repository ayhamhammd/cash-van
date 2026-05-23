import { calculateInvoice } from './invoice-calculator';

describe('invoice-calculator (fils)', () => {
  it('single TAXABLE line, no discount', () => {
    // 2 x 250.000 JOD = 500000 fils; +16% tax = 80000; total 580000
    const r = calculateInvoice({
      lines: [{ quantity: 2, unitPrice: 250_000, taxType: 'TAXABLE', taxRate: 0.16 }],
    });
    expect(r.subtotal).toBe(500_000);
    expect(r.netTaxable).toBe(500_000);
    expect(r.taxOnTaxable).toBe(80_000);
    expect(r.totalTax).toBe(80_000);
    expect(r.grandTotal).toBe(580_000);
  });

  it('INCLUSIVE line extracts embedded tax', () => {
    // 57.600 JOD inclusive of 16%: tax = round(57600 * 0.16/1.16) = 7945
    const r = calculateInvoice({
      lines: [{ quantity: 1, unitPrice: 57_600, taxType: 'INCLUSIVE', taxRate: 0.16 }],
    });
    expect(r.netInclusive).toBe(57_600);
    expect(r.taxExtractedFromInclusive).toBe(7_945);
    expect(r.lines[0].taxableBase).toBe(57_600 - 7_945);
    expect(r.lines[0].lineTotal).toBe(57_600); // unchanged
    expect(r.grandTotal).toBe(57_600);
  });

  it('EXEMPT line has no tax', () => {
    const r = calculateInvoice({
      lines: [{ quantity: 1, unitPrice: 80_000, taxType: 'EXEMPT', taxRate: 0 }],
    });
    expect(r.netExempt).toBe(80_000);
    expect(r.totalTax).toBe(0);
    expect(r.grandTotal).toBe(80_000);
  });

  it('per-line percentage discount', () => {
    // 100000 fils, 10% line discount -> net 90000; tax 14400; total 104400
    const r = calculateInvoice({
      lines: [
        {
          quantity: 1,
          unitPrice: 100_000,
          taxType: 'TAXABLE',
          taxRate: 0.16,
          lineDiscountType: 'PERCENTAGE',
          lineDiscountValue: 10,
        },
      ],
    });
    expect(r.totalLineDiscounts).toBe(10_000);
    expect(r.netTaxable).toBe(90_000);
    expect(r.taxOnTaxable).toBe(14_400);
    expect(r.grandTotal).toBe(104_400);
  });

  it('invoice-level discount distributes proportionally and lines sum to totals', () => {
    // Two taxable lines 100000 + 300000 = 400000; 10% invoice discount = 40000
    // shares: 10000 + 30000; final nets 90000 + 270000; tax 14400 + 43200
    const r = calculateInvoice({
      lines: [
        { quantity: 1, unitPrice: 100_000, taxType: 'TAXABLE', taxRate: 0.16 },
        { quantity: 1, unitPrice: 300_000, taxType: 'TAXABLE', taxRate: 0.16 },
      ],
      invoiceDiscountType: 'PERCENTAGE',
      invoiceDiscountValue: 10,
    });
    expect(r.invoiceDiscountAmount).toBe(40_000);
    expect(r.netTaxable).toBe(360_000);
    expect(r.taxOnTaxable).toBe(57_600);
    expect(r.grandTotal).toBe(417_600);
    // line totals sum to grand total
    expect(r.lines.reduce((a, l) => a + l.lineTotal, 0)).toBe(r.grandTotal);
    // discount shares sum to invoice discount exactly
    expect(r.lines.reduce((a, l) => a + l.invoiceDiscountShare, 0)).toBe(40_000);
  });

  it('mixed TAXABLE + INCLUSIVE + EXEMPT', () => {
    const r = calculateInvoice({
      lines: [
        { quantity: 1, unitPrice: 100_000, taxType: 'TAXABLE', taxRate: 0.16 },
        { quantity: 1, unitPrice: 58_000, taxType: 'INCLUSIVE', taxRate: 0.16 },
        { quantity: 1, unitPrice: 80_000, taxType: 'EXEMPT', taxRate: 0 },
      ],
    });
    expect(r.netTaxable).toBe(100_000);
    expect(r.netInclusive).toBe(58_000);
    expect(r.netExempt).toBe(80_000);
    expect(r.taxOnTaxable).toBe(16_000);
    expect(r.taxExtractedFromInclusive).toBe(roundExpected(58_000));
    expect(r.grandTotal).toBe(100_000 + 16_000 + 58_000 + 80_000);
  });
});

function roundExpected(net: number): number {
  return Math.round(net * (0.16 / 1.16));
}
