/**
 * Integration contract for the tobacco path in VouchersService.createUnchecked.
 * Composes the two real engines exactly as the service does and asserts the
 * per-line + header totals. If createUnchecked's wiring changes, this must too.
 *
 * Rules under test:
 *   • a tobacco line runs GST at 0% in calcVoucher (bypassed)
 *   • line total  = discounted net + tobacco NET tax (added on top)
 *   • header tax  = Σ GST + Σ tobacco net;  header grand = calc grand + Σ tobacco net
 */
import { calcVoucher, toFils } from './voucher-calc';
import { calculateTobaccoTax, type TobaccoTaxProfileData } from './tobacco-tax-calc';

const PROFILE: TobaccoTaxProfileData = {
  id: 'p1',
  taxBase: 'CONSUMER_PRICE',
  salesTaxEnabled: true,
  salesTaxRate: 13,
  specialTaxEnabled: true,
  specialTaxCalculationType: 'FIXED_PER_UNIT',
  specialTaxBase: 'QUANTITY',
  specialTaxRate: null,
  specialTaxFixedAmount: 600,
  withheldTaxEnabled: true,
  withheldTaxCalculationType: 'FIXED_PER_UNIT',
  withheldTaxBase: 'GROSS_TAX',
  withheldTaxAmount: 400,
  withheldTaxRate: null,
};

interface Line {
  unitPrice: string;
  itemQty: string;
  taxPercentage?: string;
  unitBaseQty?: number;
  tobacco?: { consumerFils: number };
}

/** Reproduce the exact composition from createUnchecked. */
function post(lines: Line[]) {
  const tobaccoLines = lines.map((l) => l.tobacco ?? null);

  const calc = calcVoucher({
    taxMode: 'EXCLUSIVE',
    lines: lines.map((l, i) => ({
      unitPriceFils: toFils(l.unitPrice),
      qty: Number(l.itemQty) || 0,
      taxRatePct: tobaccoLines[i] ? 0 : Number(l.taxPercentage ?? 0) || 0,
    })),
  });

  const tobaccoResults = lines.map((l, i) => {
    const t = tobaccoLines[i];
    if (!t) return null;
    const unitFactor = l.unitBaseQty && l.unitBaseQty > 0 ? l.unitBaseQty : 1;
    const baseQty = (Number(l.itemQty) || 0) * unitFactor;
    return calculateTobaccoTax({
      quantity: baseQty,
      unitPrice: Math.round(toFils(l.unitPrice) / unitFactor),
      consumerPrice: t.consumerFils,
      profile: PROFILE,
    });
  });
  const tobaccoTotal = tobaccoResults.reduce((s, r) => s + (r?.netTaxAmount ?? 0), 0);

  const lineTotals = lines.map((_, i) => {
    const res = calc.lines[i]!;
    const tob = tobaccoResults[i];
    return {
      total: res.netFils,
      netTotal: tob ? res.netFils + tob.netTaxAmount : res.totalFils,
    };
  });

  return {
    headerNetFils: calc.totalNetFils,
    headerTaxFils: calc.totalTaxFils + tobaccoTotal,
    headerGrandFils: calc.grandTotalFils + tobaccoTotal,
    lineTotals,
    tobaccoResults,
  };
}

describe('tobacco voucher integration', () => {
  it('mixed voucher: 1 tobacco line + 1 normal GST line (EXCLUSIVE)', () => {
    const r = post([
      { unitPrice: '2.000', itemQty: '10', tobacco: { consumerFils: 2500 } }, // tobacco
      { unitPrice: '5.000', itemQty: '2', taxPercentage: '16' },              // normal GST
    ]);

    // Tobacco line: GST bypassed; net 20000; tobacco net 5250; total 25250
    expect(r.tobaccoResults[0]!.netTaxAmount).toBe(5250);
    expect(r.lineTotals[0]).toEqual({ total: 20000, netTotal: 25250 });

    // Normal line: net 10000; 16% GST 1600; total 11600
    expect(r.lineTotals[1]).toEqual({ total: 10000, netTotal: 11600 });

    // Header: net 30000; tax = 1600 GST + 5250 tobacco = 6850; grand = 36850
    expect(r.headerNetFils).toBe(30000);
    expect(r.headerTaxFils).toBe(6850);
    expect(r.headerGrandFils).toBe(36850);
  });

  it('tobacco feature OFF ⇒ item taxed as plain GST (no bypass)', () => {
    // Same line but NOT flagged tobacco, with a 16% rate → ordinary GST path.
    const r = post([{ unitPrice: '2.000', itemQty: '10', taxPercentage: '16' }]);
    expect(r.tobaccoResults[0]).toBeNull();
    expect(r.lineTotals[0]).toEqual({ total: 20000, netTotal: 23200 }); // 20000 + 16%
    expect(r.headerTaxFils).toBe(3200);
  });

  it('multi-unit tobacco: excise is per BASE piece (carton of 30)', () => {
    // 2 cartons × 30 = 60 base pieces; carton price 60.000 → 2.000/piece.
    const r = post([
      { unitPrice: '60.000', itemQty: '2', unitBaseQty: 30, tobacco: { consumerFils: 2500 } },
    ]);
    // special 600 × 60 pieces = 36000; sales 13% of (2500×60=150000)=19500;
    // gross 55500; withheld 400×60=24000; net 31500
    expect(r.tobaccoResults[0]!.specialTaxAmount).toBe(36000);
    expect(r.tobaccoResults[0]!.netTaxAmount).toBe(31500);
    expect(r.lineTotals[0]!.netTotal).toBe(120000 + 31500);
  });
});
