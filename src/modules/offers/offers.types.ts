/**
 * Offers engine — shared type model.
 *
 * Offer types are a closed vocabulary. We start with a single type — a
 * PAYMENT-METHOD per-line percentage discount — and add more over time. Each
 * type's trigger/reward shapes live in the `trigger`/`reward` jsonb columns; the
 * legality per `type` is enforced in OffersService.validateConfig().
 *
 * Money: all amounts in this module are INTEGER fils (1 JOD = 1000 fils), the
 * project's canonical unit (see src/common/utils/currency.util.ts). Item discounts
 * come in two flavours: PERCENT (0–100) and a fixed AMOUNT-off per unit (fils).
 */

export type OfferType = 'PAYMENT_METHOD_DISCOUNT' | 'ITEM_QTY_REWARD';

export const OFFER_TYPES: OfferType[] = [
  'PAYMENT_METHOD_DISCOUNT',
  'ITEM_QTY_REWARD',
];

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

export type RewardKind =
  | 'LINE_PERCENT_DISCOUNT'
  | 'LINE_AMOUNT_DISCOUNT'
  | 'GIFT'
  | 'ITEM_PERCENT_DISCOUNT'
  | 'ITEM_AMOUNT_DISCOUNT';
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

/** ITEM_QTY_REWARD: the offer's selected items. The trigger quantity is the
 *  COMBINED qty of these items in the cart. */
export interface ItemSetTrigger {
  itemNumbers: string[];
}

export type OfferTriggerConfig =
  | PaymentMethodTrigger
  | ItemSetTrigger
  | Record<string, never>;

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

/**
 * A fixed amount (fils) off EVERY line of the order — the amount-off twin of
 * LinePercentDiscountReward, for a PAYMENT_METHOD_DISCOUNT. Each qualifying line
 * gets `baseAmountFils` off (a flat amount per line, independent of the line qty),
 * clamped to the line gross. STATIC keeps it fixed; DYNAMIC scales it with the
 * order's item count the same way the percent reward does:
 *   effectiveAmount = baseAmountFils × (1 + multiplier × floor((count − anchor) / itemsPerStep))
 * capped at `maxAmountFils`.
 */
export interface LineAmountDiscountReward {
  kind: 'LINE_AMOUNT_DISCOUNT';
  /** Amount off each line, in fils. */
  baseAmountFils: number;
  mode: DiscountMode;
  /** DYNAMIC only: fraction of base added per step, e.g. 0.5. */
  multiplier?: number;
  /** DYNAMIC only: items per multiplication step, e.g. 6. */
  itemsPerStep?: number;
  /** DYNAMIC only: cap on the per-line amount, in fils. */
  maxAmountFils?: number;
}

/**
 * ITEM_QTY_REWARD gift: the system computes the number of free gifts from the
 * combined selected-item qty — one free gift per `itemsPerGift` bought
 * (`freeQty = floor(qty / itemsPerGift)`), capped at `maxFreeQty`. The rep picks
 * that many items from the `giftItems` pool at sale; each is added at 100% off
 * (net 0). E.g. itemsPerGift = 10 → buy 10 → 1, buy 20 → 2, buy 1000 → 100.
 */
export interface GiftReward {
  kind: 'GIFT';
  /** Pool of item numbers the rep may choose the free gift(s) from. */
  giftItems: string[];
  /** Buy this many of the selected items to earn one step of free gifts. */
  itemsPerGift: number;
  /** Free gifts granted per step (default 1). E.g. itemsPerGift 10 +
   *  giftsPerStep 3 → buy 10 → 3 free, buy 20 → 6 free. */
  giftsPerStep?: number;
  /** Optional cap on the number of free gifts. */
  maxFreeQty?: number;
}

/**
 * ITEM_QTY_REWARD discount: once the combined selected-item qty reaches `minQty`,
 * a percentage comes off each SELECTED item's line. STATIC = flat basePercent;
 * DYNAMIC = basePercent × (1 + multiplier × floor(qty / itemsPerStep)) capped.
 */
export interface ItemPercentDiscountReward {
  kind: 'ITEM_PERCENT_DISCOUNT';
  /** Threshold on the combined selected-item qty. */
  minQty: number;
  basePercent: number;
  mode: DiscountMode;
  multiplier?: number;
  itemsPerStep?: number;
  maxPercent?: number;
}

/**
 * ITEM_QTY_REWARD discount: once the combined selected-item qty reaches `minQty`,
 * a fixed amount (fils) comes off EACH UNIT of the selected items — the amount-off
 * twin of ItemPercentDiscountReward. STATIC = flat baseAmountFils per unit;
 * DYNAMIC = baseAmountFils × (1 + multiplier × floor((qty − minQty) / itemsPerStep))
 * capped at `maxAmountFils`. The per-line discount is amount × line qty, clamped to
 * the line gross so it can never drive the line below zero.
 */
export interface ItemAmountDiscountReward {
  kind: 'ITEM_AMOUNT_DISCOUNT';
  /** Threshold on the combined selected-item qty. */
  minQty: number;
  /** Amount off per unit, in fils. */
  baseAmountFils: number;
  mode: DiscountMode;
  /** DYNAMIC only: fraction of base added per step, e.g. 0.5. */
  multiplier?: number;
  /** DYNAMIC only: items per multiplication step, e.g. 6. */
  itemsPerStep?: number;
  /** DYNAMIC only: cap on the effective per-unit amount, in fils. */
  maxAmountFils?: number;
}

export type OfferRewardConfig =
  | LinePercentDiscountReward
  | LineAmountDiscountReward
  | GiftReward
  | ItemPercentDiscountReward
  | ItemAmountDiscountReward;

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
  /** Gift items the rep chose (ITEM_QTY_REWARD gifts) — resolved to free lines. */
  chosenFreeItems?: string[] | null;
  /** Evaluation instant; defaults to now. */
  at?: Date;
}

/** One offer's contribution to a single line — drives the per-line offer label. */
export interface LineOfferRef {
  offerId: string;
  name: string;
  /** The percentage this offer applied to the line (0–100). */
  pct: number;
  /** Discount this offer contributed to the line (fils). */
  discountFils: number;
}

export interface EvaluatedLine {
  itemNumber: string;
  qty: number;
  unitPriceFils: number;
  /** Discount applied to this line by all offers (fils). */
  lineDiscountFils: number;
  /** qty·unitPrice − lineDiscount (pre-tax, fils). */
  lineNetFils: number;
  /** The offer(s) that discounted this line, each with its % and fils share. */
  offers: LineOfferRef[];
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
