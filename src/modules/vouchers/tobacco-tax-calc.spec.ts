/**
 * Tobacco tax engine — spec-parity tests. These vectors MUST produce identical
 * results in the ERP (src/lib/__tests__/tobacco-tax-engine.test.ts) and the
 * FlowVan app Kotlin port. All money = integer fils; rates = integer percent.
 */
import {
  calculateTobaccoTax,
  validateTobaccoInput,
  type TobaccoTaxProfileData,
} from './tobacco-tax-calc';

const BASE_PROFILE: TobaccoTaxProfileData = {
  id: 'profile-1',
  taxBase: 'CONSUMER_PRICE',
  salesTaxEnabled: true,
  salesTaxRate: 13,
  taxIncludedInConsumerPrice: false,
  specialTaxEnabled: true,
  specialTaxCalculationType: 'FIXED_PER_UNIT',
  specialTaxBase: 'QUANTITY',
  specialTaxRate: null,
  specialTaxFixedAmount: 600, // 0.600 JOD per unit
  withheldTaxEnabled: true,
  withheldTaxCalculationType: 'FIXED_PER_UNIT',
  withheldTaxBase: 'GROSS_TAX',
  withheldTaxAmount: 400, // 0.400 JOD per unit
  withheldTaxRate: null,
};

describe('calculateTobaccoTax', () => {
  it('spec worked example: qty=10, unit=2.000, consumer=2.500', () => {
    const r = calculateTobaccoTax({ quantity: 10, unitPrice: 2000, consumerPrice: 2500, profile: BASE_PROFILE });
    expect(r.salesTaxAmount).toBe(3250); // 25000 × 13%
    expect(r.specialTaxAmount).toBe(6000); // 600 × 10
    expect(r.withheldTaxAmount).toBe(4000); // 400 × 10
    expect(r.grossTaxAmount).toBe(9250);
    expect(r.netTaxAmount).toBe(5250);
  });

  it('taxIncludedInConsumerPrice=true extracts the tax (BOHEM: consumer 25.000, 16%)', () => {
    const p: TobaccoTaxProfileData = {
      ...BASE_PROFILE,
      salesTaxRate: 16,
      taxIncludedInConsumerPrice: true,
      specialTaxEnabled: false,
      withheldTaxEnabled: false,
    };
    const r = calculateTobaccoTax({ quantity: 1, unitPrice: 24700, consumerPrice: 25000, profile: p });
    expect(r.salesTaxAmount).toBe(3448); // 25000 × 16 / 116, matches the ERP engine
    expect(r.netTaxAmount).toBe(3448);
  });

  it('taxIncludedInConsumerPrice=false adds the tax on top', () => {
    const p: TobaccoTaxProfileData = {
      ...BASE_PROFILE,
      salesTaxRate: 16,
      taxIncludedInConsumerPrice: false,
      specialTaxEnabled: false,
      withheldTaxEnabled: false,
    };
    const r = calculateTobaccoTax({ quantity: 1, unitPrice: 24700, consumerPrice: 25000, profile: p });
    expect(r.salesTaxAmount).toBe(4000); // 25000 × 16 / 100
  });

  it('sales tax on SALE_PRICE base', () => {
    const p: TobaccoTaxProfileData = { ...BASE_PROFILE, taxBase: 'SALE_PRICE', specialTaxEnabled: false, withheldTaxEnabled: false };
    const r = calculateTobaccoTax({ quantity: 4, unitPrice: 1000, consumerPrice: 1500, profile: p });
    expect(r.salesTaxAmount).toBe(520); // 4000 × 13%
    expect(r.netTaxAmount).toBe(520);
  });

  it('special tax FIXED_PLUS_RATE on consumer base', () => {
    const p: TobaccoTaxProfileData = {
      ...BASE_PROFILE,
      salesTaxEnabled: false,
      withheldTaxEnabled: false,
      specialTaxCalculationType: 'FIXED_PLUS_RATE',
      specialTaxBase: 'CONSUMER_PRICE',
      specialTaxFixedAmount: 100,
      specialTaxRate: 10,
    };
    const r = calculateTobaccoTax({ quantity: 5, unitPrice: 2000, consumerPrice: 3000, profile: p });
    // fixed 100×5=500 + rate 10% of (3000×5=15000)=1500 → 2000
    expect(r.specialTaxAmount).toBe(2000);
    expect(r.netTaxAmount).toBe(2000);
  });

  it('withheld RATE on GROSS_TAX base', () => {
    const p: TobaccoTaxProfileData = {
      ...BASE_PROFILE,
      specialTaxEnabled: false,
      withheldTaxCalculationType: 'RATE',
      withheldTaxBase: 'GROSS_TAX',
      withheldTaxRate: 20,
      withheldTaxAmount: null,
    };
    const r = calculateTobaccoTax({ quantity: 10, unitPrice: 2000, consumerPrice: 2500, profile: p });
    // sales tax 13% of 25000 = 3250 (gross); withheld 20% of 3250 = 650 → net 2600
    expect(r.grossTaxAmount).toBe(3250);
    expect(r.withheldTaxAmount).toBe(650);
    expect(r.netTaxAmount).toBe(2600);
  });

  it('never lets withheld push net below zero', () => {
    const p: TobaccoTaxProfileData = { ...BASE_PROFILE, withheldTaxAmount: 999999 };
    const r = calculateTobaccoTax({ quantity: 1, unitPrice: 2000, consumerPrice: 2500, profile: p });
    expect(r.netTaxAmount).toBe(0);
  });

  it('validation requires a profile, positive qty, and consumer price for consumer base', () => {
    expect(validateTobaccoInput({ quantity: 1, unitPrice: 1000, consumerPrice: 0, profile: null })).toBeTruthy();
    expect(validateTobaccoInput({ quantity: 0, unitPrice: 1000, consumerPrice: 1000, profile: BASE_PROFILE })).toBeTruthy();
    expect(validateTobaccoInput({ quantity: 1, unitPrice: 1000, consumerPrice: 0, profile: BASE_PROFILE })).toBeTruthy();
    expect(validateTobaccoInput({ quantity: 1, unitPrice: 1000, consumerPrice: 2500, profile: BASE_PROFILE })).toBeNull();
  });
});
