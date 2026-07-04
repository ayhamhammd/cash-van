/**
 * Tobacco Tax Engine — Jordan (cash-van backend twin of ERP/src/lib/tobacco-tax-engine.ts)
 *
 * MUST stay byte-identical to the ERP engine and the FlowVan app Kotlin port —
 * same inputs → same integer output. Do not "improve" the math here in isolation;
 * change all three together (see docs/SPEC-tobacco-tax.md).
 *
 * Three tax components that may apply to tobacco/cigarette products:
 *   1. Sales Tax     — on sale price or consumer price
 *   2. Special Tax   — fixed per unit, rate, or fixed+rate (excise)
 *   3. Withheld Tax  — prepaid amount deducted from gross liability
 *
 * All monetary values are integer **fils** (JOD × 1000). Quantities may be
 * fractional. Rates are plain percentage integers (13% = 13). Round-half-up to
 * the nearest fil at each step (Math.round).
 *
 * Example (from spec):
 *   qty=10, unitPrice=2000, consumerPrice=2500, salesTaxRate=13%,
 *   specialTaxFixed=600/unit, withheldTaxFixed=400/unit
 *   → salesTax=3250, specialTax=6000, withheld=4000
 *   → grossTax=9250, netTax=5250
 */

export type TaxBase = 'SALE_PRICE' | 'CONSUMER_PRICE';

export type SpecialTaxCalcType = 'NONE' | 'FIXED_PER_UNIT' | 'RATE' | 'FIXED_PLUS_RATE';
export type SpecialTaxBase = 'SALE_PRICE' | 'CONSUMER_PRICE' | 'QUANTITY';

export type WithheldTaxCalcType = 'NONE' | 'FIXED_PER_UNIT' | 'RATE';
export type WithheldTaxBase = 'SALE_PRICE' | 'CONSUMER_PRICE' | 'GROSS_TAX';

export interface TobaccoTaxProfileData {
  id: string;
  taxBase: TaxBase;

  salesTaxEnabled: boolean;
  salesTaxRate: number; // percentageInteger

  specialTaxEnabled: boolean;
  specialTaxCalculationType: SpecialTaxCalcType;
  specialTaxBase: SpecialTaxBase;
  specialTaxRate: number | null; // percentageInteger
  specialTaxFixedAmount: number | null; // integer fils per unit

  withheldTaxEnabled: boolean;
  withheldTaxCalculationType: WithheldTaxCalcType;
  withheldTaxBase: WithheldTaxBase;
  withheldTaxAmount: number | null; // integer fils per unit
  withheldTaxRate: number | null; // percentageInteger
}

export interface TobaccoTaxInput {
  quantity: number;
  unitPrice: number; // integer fils
  consumerPrice: number; // integer fils
  profile: TobaccoTaxProfileData;
}

export interface TobaccoCalcDetails {
  taxBase: TaxBase;
  saleBase: number;
  consumerBase: number;
  salesTaxBase: number;
  salesTaxRate: number;
  salesTaxAmount: number;
  specialCalcType: SpecialTaxCalcType;
  specialTaxBase: number;
  specialTaxAmount: number;
  withheldCalcType: WithheldTaxCalcType;
  withheldTaxBase: number;
  withheldTaxAmount: number;
  grossTaxAmount: number;
  netTaxAmount: number;
}

export interface TobaccoTaxResult {
  taxBaseAmount: number;
  consumerValue: number;
  salesTaxAmount: number;
  specialTaxAmount: number;
  withheldTaxAmount: number;
  grossTaxAmount: number;
  netTaxAmount: number;
  effectiveTaxRate: number; // netTax / saleBase × 100 (display only)
  profileId: string;
  calculationDetails: TobaccoCalcDetails;
}

export type TobaccoTaxValidationError = string;

export function validateTobaccoInput(
  input: Omit<TobaccoTaxInput, 'profile'> & { profile: TobaccoTaxProfileData | null },
): TobaccoTaxValidationError | null {
  if (!input.profile) return 'Tobacco tax profile is required';
  if (input.quantity <= 0) return 'Quantity must be positive';
  if (input.unitPrice < 0) return 'Unit price cannot be negative';
  if (input.profile.taxBase === 'CONSUMER_PRICE' && (!input.consumerPrice || input.consumerPrice <= 0)) {
    return 'Consumer price is required for consumer-price tax base';
  }
  return null;
}

export function calculateTobaccoTax(input: TobaccoTaxInput): TobaccoTaxResult {
  const { quantity, unitPrice, consumerPrice, profile } = input;

  const saleBase = unitPrice * quantity; // total sale value
  const consumerBase = consumerPrice * quantity; // total consumer value

  // ── 1. Sales Tax ────────────────────────────────────────────────────────
  const salesTaxBase = profile.taxBase === 'CONSUMER_PRICE' ? consumerBase : saleBase;
  const salesTax =
    profile.salesTaxEnabled && profile.salesTaxRate > 0
      ? Math.round((salesTaxBase * profile.salesTaxRate) / 100)
      : 0;

  // ── 2. Special Tax ──────────────────────────────────────────────────────
  const specialTax = calculateSpecialTax(quantity, saleBase, consumerBase, profile);

  // ── 3. Withheld Tax ─────────────────────────────────────────────────────
  const grossTax = salesTax + specialTax;
  const withheldTax = calculateWithheldTax(quantity, saleBase, consumerBase, grossTax, profile);

  const netTax = Math.max(grossTax - withheldTax, 0);

  const effectiveTaxRate = saleBase > 0 ? Math.round((netTax / saleBase) * 10000) / 100 : 0;

  const details: TobaccoCalcDetails = {
    taxBase: profile.taxBase,
    saleBase,
    consumerBase,
    salesTaxBase,
    salesTaxRate: profile.salesTaxRate,
    salesTaxAmount: salesTax,
    specialCalcType: profile.specialTaxCalculationType,
    specialTaxBase: profile.specialTaxBase === 'CONSUMER_PRICE' ? consumerBase : saleBase,
    specialTaxAmount: specialTax,
    withheldCalcType: profile.withheldTaxCalculationType,
    withheldTaxBase: withheldTaxBaseAmount(quantity, saleBase, consumerBase, grossTax, profile),
    withheldTaxAmount: withheldTax,
    grossTaxAmount: grossTax,
    netTaxAmount: netTax,
  };

  return {
    taxBaseAmount: salesTaxBase,
    consumerValue: consumerBase,
    salesTaxAmount: salesTax,
    specialTaxAmount: specialTax,
    withheldTaxAmount: withheldTax,
    grossTaxAmount: grossTax,
    netTaxAmount: netTax,
    effectiveTaxRate,
    profileId: profile.id,
    calculationDetails: details,
  };
}

function calculateSpecialTax(
  quantity: number,
  saleBase: number,
  consumerBase: number,
  profile: TobaccoTaxProfileData,
): number {
  if (!profile.specialTaxEnabled) return 0;

  const calcType = profile.specialTaxCalculationType;
  if (calcType === 'NONE') return 0;

  const base =
    profile.specialTaxBase === 'CONSUMER_PRICE'
      ? consumerBase
      : profile.specialTaxBase === 'QUANTITY'
        ? quantity
        : saleBase;

  if (calcType === 'FIXED_PER_UNIT') {
    const fixed = profile.specialTaxFixedAmount ?? 0;
    return fixed * quantity;
  }

  if (calcType === 'RATE') {
    const rate = profile.specialTaxRate ?? 0;
    return Math.round((base * rate) / 100);
  }

  if (calcType === 'FIXED_PLUS_RATE') {
    const fixed = profile.specialTaxFixedAmount ?? 0;
    const rate = profile.specialTaxRate ?? 0;
    return fixed * quantity + Math.round((base * rate) / 100);
  }

  return 0;
}

function withheldTaxBaseAmount(
  quantity: number,
  saleBase: number,
  consumerBase: number,
  grossTax: number,
  profile: TobaccoTaxProfileData,
): number {
  const b = profile.withheldTaxBase;
  if (b === 'CONSUMER_PRICE') return consumerBase;
  if (b === 'GROSS_TAX') return grossTax;
  return saleBase;
}

function calculateWithheldTax(
  quantity: number,
  saleBase: number,
  consumerBase: number,
  grossTax: number,
  profile: TobaccoTaxProfileData,
): number {
  if (!profile.withheldTaxEnabled) return 0;

  const calcType = profile.withheldTaxCalculationType;
  if (calcType === 'NONE') return 0;

  if (calcType === 'FIXED_PER_UNIT') {
    const amt = profile.withheldTaxAmount ?? 0;
    return amt * quantity;
  }

  if (calcType === 'RATE') {
    const base = withheldTaxBaseAmount(quantity, saleBase, consumerBase, grossTax, profile);
    const rate = profile.withheldTaxRate ?? 0;
    return Math.round((base * rate) / 100);
  }

  return 0;
}
