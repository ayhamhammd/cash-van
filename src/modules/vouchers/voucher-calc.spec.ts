import { calcVoucher, type CalcInput } from './voucher-calc';

/**
 * CANONICAL FIXTURES — the contract every system (backend, FlowVan app, ERP)
 * must reproduce to the fil. Keep in sync with docs/VOUCHER-CALC-SPEC.md and the
 * Kotlin/ERP ports. All amounts are integer fils (JOD × 1000).
 */
describe('calcVoucher (canonical money engine)', () => {
  it('EXCLUSIVE · single line · no discount', () => {
    const r = calcVoucher({
      taxMode: 'EXCLUSIVE',
      lines: [{ unitPriceFils: 1000, qty: 2, taxRatePct: 16 }],
    });
    expect(r.lines[0]).toMatchObject({ netFils: 2000, taxFils: 320, totalFils: 2320 });
    expect(r).toMatchObject({ totalNetFils: 2000, totalTaxFils: 320, grandTotalFils: 2320 });
  });

  it('INCLUSIVE · single line · tax extracted from price', () => {
    const r = calcVoucher({
      taxMode: 'INCLUSIVE',
      lines: [{ unitPriceFils: 1160, qty: 1, taxRatePct: 16 }],
    });
    expect(r.lines[0]).toMatchObject({ taxableFils: 1000, taxFils: 160, totalFils: 1160 });
    expect(r).toMatchObject({ totalNetFils: 1000, totalTaxFils: 160, grandTotalFils: 1160 });
  });

  it('EXCLUSIVE · line percentage discount', () => {
    const r = calcVoucher({
      taxMode: 'EXCLUSIVE',
      lines: [{ unitPriceFils: 1000, qty: 1, lineDiscountPct: 10, taxRatePct: 16 }],
    });
    expect(r.lines[0]).toMatchObject({ lineDiscountFils: 100, netFils: 900, taxFils: 144, totalFils: 1044 });
  });

  it('EXCLUSIVE · line percentage + fixed value stacked', () => {
    const r = calcVoucher({
      taxMode: 'EXCLUSIVE',
      lines: [{ unitPriceFils: 1000, qty: 1, lineDiscountPct: 10, lineDiscountFils: 50, taxRatePct: 16 }],
    });
    expect(r.lines[0]).toMatchObject({ lineDiscountFils: 150, netFils: 850, taxFils: 136, totalFils: 986 });
  });

  it('EXCLUSIVE · header % discount distributed by net share', () => {
    const r = calcVoucher({
      taxMode: 'EXCLUSIVE',
      headerDiscountPct: 10,
      lines: [
        { unitPriceFils: 1000, qty: 1, taxRatePct: 16 },
        { unitPriceFils: 2000, qty: 1, taxRatePct: 16 },
      ],
    });
    expect(r.headerDiscountFils).toBe(300);
    expect(r.lines[0]).toMatchObject({ headerShareFils: 100, netFils: 900, taxFils: 144, totalFils: 1044 });
    expect(r.lines[1]).toMatchObject({ headerShareFils: 200, netFils: 1800, taxFils: 288, totalFils: 2088 });
    expect(r).toMatchObject({ totalNetFils: 2700, totalTaxFils: 432, grandTotalFils: 3132 });
  });

  it('EXCLUSIVE · header fixed discount with rounding remainder on last line', () => {
    const r = calcVoucher({
      taxMode: 'EXCLUSIVE',
      headerDiscountFils: 100,
      lines: [
        { unitPriceFils: 1000, qty: 1, taxRatePct: 16 },
        { unitPriceFils: 1000, qty: 1, taxRatePct: 16 },
        { unitPriceFils: 1000, qty: 1, taxRatePct: 16 },
      ],
    });
    // 100 / 3 = 33,33,34 (remainder on last line)
    expect(r.lines.map((l) => l.headerShareFils)).toEqual([33, 33, 34]);
    expect(r.headerDiscountFils).toBe(100);
    expect(r).toMatchObject({ totalNetFils: 2900, totalTaxFils: 465, grandTotalFils: 3365 });
    // grand == sumNet − headerDisc + tax
    expect(r.grandTotalFils).toBe(3000 - 100 + r.totalTaxFils);
  });

  it('INCLUSIVE · with header discount', () => {
    const r = calcVoucher({
      taxMode: 'INCLUSIVE',
      headerDiscountFils: 160,
      lines: [{ unitPriceFils: 1160, qty: 1, taxRatePct: 16 }],
    });
    expect(r.lines[0]).toMatchObject({ netFils: 1000, taxableFils: 862, taxFils: 138, totalFils: 1000 });
    expect(r).toMatchObject({ totalNetFils: 862, totalTaxFils: 138, grandTotalFils: 1000 });
  });

  it('EXCLUSIVE · zero-rate (exempt) line adds no tax', () => {
    const r = calcVoucher({
      taxMode: 'EXCLUSIVE',
      lines: [{ unitPriceFils: 1000, qty: 1, taxRatePct: 0 }],
    });
    expect(r.lines[0]).toMatchObject({ taxFils: 0, totalFils: 1000 });
  });

  it('invariant · grandTotal == totalNet + totalTax for any input', () => {
    const cases: CalcInput[] = [
      { taxMode: 'EXCLUSIVE', headerDiscountPct: 7, lines: [
        { unitPriceFils: 1234, qty: 3, lineDiscountPct: 5, lineDiscountFils: 20, taxRatePct: 16 },
        { unitPriceFils: 555, qty: 2, taxRatePct: 16 },
      ] },
      { taxMode: 'INCLUSIVE', headerDiscountFils: 333, lines: [
        { unitPriceFils: 1740, qty: 1, taxRatePct: 16 },
        { unitPriceFils: 2900, qty: 4, lineDiscountPct: 12, taxRatePct: 16 },
      ] },
    ];
    for (const c of cases) {
      const r = calcVoucher(c);
      expect(r.grandTotalFils).toBe(r.totalNetFils + r.totalTaxFils);
    }
  });
});
