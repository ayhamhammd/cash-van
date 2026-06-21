/**
 * Offers engine — shared type model.
 *
 * The five offer types are a closed vocabulary (mirrors the dashboard wizard in
 * docs/features/OFFERS-BE.md §1). Each type allows only a subset of rewards;
 * the legality matrix is enforced in OffersService.validateConfig().
 *
 * Money: all amounts in this module are INTEGER fils (1 JOD = 1000 fils), the
 * project's canonical unit (see src/common/utils/currency.util.ts). A DISCOUNT
 * reward of kind VALUE is therefore expressed in fils; of kind PERCENT in
 * whole-percent (0–100).
 */

export type OfferType =
  | 'ITEM_QTY_DISCOUNT'
  | 'BUY_X_GET_Y_FREE'
  | 'BASKET_THRESHOLD'
  | 'ITEM_SET_THRESHOLD'
  | 'LOYALTY_FIRST_PURCHASE';

export const OFFER_TYPES: OfferType[] = [
  'ITEM_QTY_DISCOUNT',
  'BUY_X_GET_Y_FREE',
  'BASKET_THRESHOLD',
  'ITEM_SET_THRESHOLD',
  'LOYALTY_FIRST_PURCHASE',
];

export type DiscountKind = 'PERCENT' | 'VALUE';
export type AppliesTo = 'TRIGGER_ITEM' | 'SET' | 'INVOICE';
export type SetMatch = 'ANY' | 'ALL';
export type RewardKind = 'DISCOUNT' | 'FREE_ITEM' | 'FREE_ITEM_CHOICE';
export type CustomerScope = 'ALL' | 'SEGMENT' | 'SPECIFIC' | 'NEW_ONLY';

// ---- trigger configs (one shape per type; LOYALTY has none) ----

export interface ItemQtyTrigger {
  itemNumber: string;
  minQty: number;
}
export interface BuyXGetYTrigger {
  itemNumber: string;
  qty: number;
}
export interface BasketThresholdTrigger {
  itemNumbers: string[];
  minItemCount: number;
}
export interface ItemSetThresholdTrigger {
  itemNumbers: string[];
  minTotalQty: number;
  match: SetMatch;
}

export type OfferTriggerConfig =
  | ItemQtyTrigger
  | BuyXGetYTrigger
  | BasketThresholdTrigger
  | ItemSetThresholdTrigger
  | Record<string, never>;

// ---- reward configs ----

export interface FreeItemSpec {
  itemNumber: string;
  qty: number;
}

export interface DiscountReward {
  kind: 'DISCOUNT';
  discountType: DiscountKind;
  /** PERCENT → 0–100. VALUE → fils. */
  value: number;
  appliesTo: AppliesTo;
}
export interface FreeItemReward {
  kind: 'FREE_ITEM';
  items: FreeItemSpec[];
}
/** A list the rep chooses from at sale time; the engine surfaces it but does
 *  not auto-add a line (the chosen item/qty is decided on the device). */
export interface FreeItemChoiceReward {
  kind: 'FREE_ITEM_CHOICE';
  choices: string[];
  qty: number;
}

export type OfferRewardConfig =
  | DiscountReward
  | FreeItemReward
  | FreeItemChoiceReward;

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
  /** Human-readable one-liner, e.g. "6× ICETEA-330 → 1 WATER-500 free". */
  summary: string;
  /** Total discount this offer granted across lines + invoice (fils). */
  discountFils: number;
  freeItems: FreeItemSpec[];
  /** Present only for FREE_ITEM_CHOICE: the rep must pick at sale. */
  freeItemChoice?: { choices: string[]; qty: number };
}

export interface EvaluationResult {
  lines: EvaluatedLine[];
  freeLines: FreeLine[];
  /** Invoice-level discount from BASKET_THRESHOLD / LOYALTY rewards (fils). */
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
