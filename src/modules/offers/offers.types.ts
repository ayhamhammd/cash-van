/**
 * Offers engine — shared type model.
 *
 * Offer types are a closed vocabulary. We start with a single type — a
 * PAYMENT-METHOD per-line percentage discount — and add more over time. Each
 * type's trigger/reward shapes live in the `trigger`/`reward` jsonb columns; the
 * legality per `type` is enforced in OffersService.validateConfig().
 *
 * Money: all amounts in this module are INTEGER fils (1 JOD = 1000 fils), the
 * project's canonical unit (see src/common/utils/currency.util.ts). Discounts in
 * this iteration are PERCENT only (0–100); amount-off rewards are out of scope.
 */

export type OfferType = 'PAYMENT_METHOD_DISCOUNT';

export const OFFER_TYPES: OfferType[] = ['PAYMENT_METHOD_DISCOUNT'];

/** Payment types as they arrive on a voucher (payments[].paymentType). */
export type PaymentType = 'CASH' | 'CHEQUE' | 'TRANSFER' | 'CARD' | 'CREDIT';
export const PAYMENT_TYPES: PaymentType[] = [
  'CASH',
  'CHEQUE',
  'TRANSFER',
  'CARD',
  'CREDIT',
];

/** The binary condition an offer targets. CASH = any non-CREDIT payment. */
export type PaymentCondition = 'CASH' | 'CREDIT';
export const PAYMENT_CONDITIONS: PaymentCondition[] = ['CASH', 'CREDIT'];

export type DiscountMode = 'STATIC' | 'DYNAMIC';
export const DISCOUNT_MODES: DiscountMode[] = ['STATIC', 'DYNAMIC'];

export type RewardKind = 'LINE_PERCENT_DISCOUNT';
export type CustomerScope = 'ALL' | 'SEGMENT' | 'SPECIFIC' | 'NEW_ONLY';

// ---- trigger configs ----

export interface PaymentMethodTrigger {
  /** CASH matches any non-CREDIT payment; CREDIT matches CREDIT only. */
  paymentCondition: PaymentCondition;
  /** Minimum order subtotal (fils) for the offer to apply. */
  minOrderTotal?: number;
  /** Minimum total item count (sum of qty) for the offer to apply. */
  minItemCount?: number;
}

export type OfferTriggerConfig = PaymentMethodTrigger | Record<string, never>;

// ---- reward configs ----

/** A free item granted by an offer (kept for the redemption ledger shape). */
export interface FreeItemSpec {
  itemNumber: string;
  qty: number;
}

/**
 * A percentage discount applied to EVERY line of the order. STATIC keeps the
 * percent fixed; DYNAMIC scales it up with the order's item count:
 *   effectivePct = basePercent × (1 + multiplier × floor(itemCount / itemsPerStep))
 * capped at maxPercent (and never above 100).
 */
export interface LinePercentDiscountReward {
  kind: 'LINE_PERCENT_DISCOUNT';
  /** Base percentage, 0–100. */
  basePercent: number;
  mode: DiscountMode;
  /** DYNAMIC only: fraction of base added per step, e.g. 0.5. */
  multiplier?: number;
  /** DYNAMIC only: items per multiplication step, e.g. 6. */
  itemsPerStep?: number;
  /** DYNAMIC only: cap on the effective percent, 0–100. */
  maxPercent?: number;
}

export type OfferRewardConfig = LinePercentDiscountReward;

// ---- eligibility / targeting ----

export interface OfferEligibility {
  customerScope: CustomerScope;
  /** SEGMENT: matches customer.category. */
  segments?: string[];
  /** SPECIFIC: explicit customer numbers. */
  customerNumbers?: string[];
  regionIds?: string[];
  repIds?: string[];
  storeNumbers?: string[];
}

// ---- evaluation I/O (the /offers/evaluate contract) ----

export interface CartLineInput {
  itemNumber: string;
  qty: number;
}

export interface EvaluationContext {
  customerNumber?: string | null;
  repId?: string | null;
  storeNumber?: string | null;
  /** The order's payment method — drives PAYMENT_METHOD_DISCOUNT matching. */
  paymentMethod?: PaymentType | null;
  /** Evaluation instant; defaults to now. */
  at?: Date;
}

export interface EvaluatedLine {
  itemNumber: string;
  qty: number;
  unitPriceFils: number;
  /** Discount applied to this line by all offers (fils). */
  lineDiscountFils: number;
  /** qty·unitPrice − lineDiscount (pre-tax, fils). */
  lineNetFils: number;
}

export interface FreeLine {
  itemNumber: string;
  qty: number;
  unitPriceFils: number;
  /** The offer id that granted this free line. */
  offerId: string;
}

export interface AppliedOffer {
  offerId: string;
  name: string;
  type: OfferType;
  /** Human-readable one-liner, e.g. "Cash · 5% off each line". */
  summary: string;
  /** Total discount this offer granted across lines + invoice (fils). */
  discountFils: number;
  freeItems: FreeItemSpec[];
  /** Reserved for future free-item-choice types. */
  freeItemChoice?: { choices: string[]; qty: number };
}

export interface EvaluationResult {
  lines: EvaluatedLine[];
  freeLines: FreeLine[];
  /** Invoice-level discount (unused by current types; kept for the contract). */
  invoiceDiscountFils: number;
  appliedOffers: AppliedOffer[];
  totals: {
    subtotalFils: number;
    lineDiscountFils: number;
    invoiceDiscountFils: number;
    totalDiscountFils: number;
    taxFils: number;
    grandTotalFils: number;
  };
}
