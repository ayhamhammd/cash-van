import { calculateInvoice } from '../invoices/invoice-calculator';
import { filsToJod } from '../../common/utils/currency.util';

/**
 * Determinism tests porting the Jordan tax spec scenarios. Each asserts both
 * the fils integer and the JoFotara JOD-string representation.
 */
describe('Jordan tax — spec scenarios', () => {
  it('partial return: 1 of 2 phones @ 250.000 JOD taxable', () => {
    // Return one unit at 250000 fils, 16% taxable.
    const calc = calculateInvoice({
      lines: [{ quantity: 1, unitPrice: 250_000, taxType: 'TAXABLE', taxRate: 0.16 }],
    });
    expect(calc.netTaxable).toBe(250_000);
    expect(calc.totalTax).toBe(40_000);
    expect(calc.grandTotal).toBe(290_000);
    // JoFotara payload strings
    expect(filsToJod(calc.netTaxable)).toBe('250.000');
    expect(filsToJod(calc.totalTax)).toBe('40.000');
    expect(filsToJod(calc.grandTotal)).toBe('290.000');
  });

  it('monthly net output tax: 2 sales − 1 return', () => {
    const sale1Tax = 80_000; // 500000 @ 16%
    const sale2Tax = 40_000; // 250000 @ 16%
    const returnTax = -40_000; // reversed
    const netOutputTax = sale1Tax + sale2Tax + returnTax;
    expect(netOutputTax).toBe(80_000);
    expect(filsToJod(netOutputTax)).toBe('80.000');
  });

  it('inclusive extraction matches JOD string', () => {
    const calc = calculateInvoice({
      lines: [{ quantity: 1, unitPrice: 116_000, taxType: 'INCLUSIVE', taxRate: 0.16 }],
    });
    // tax = round(116000 * 0.16/1.16) = 16000
    expect(calc.taxExtractedFromInclusive).toBe(16_000);
    expect(calc.grandTotal).toBe(116_000);
    expect(filsToJod(calc.taxExtractedFromInclusive)).toBe('16.000');
  });
});
