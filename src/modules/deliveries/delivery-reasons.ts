/**
 * Discrepancy reasons (delivery phase-2 contract §0, BE spec §2). Each one
 * decides the condition of the goods, which is where the stock goes back on an
 * approved return.
 */
export const REASON_CONDITION = {
  NOT_LOADED: 'GOOD',
  CUSTOMER_REFUSED: 'GOOD',
  DAMAGED: 'DAMAGED',
  EXPIRED: 'DAMAGED',
  WRONG_ITEM: 'GOOD',
  LOST: 'DAMAGED',
  OTHER: 'GOOD',
} as const;

export type ReasonCode = keyof typeof REASON_CONDITION;
export type GoodsCondition = (typeof REASON_CONDITION)[ReasonCode];
export const REASON_CODES = Object.keys(REASON_CONDITION) as ReasonCode[];

export function conditionOf(reason: string | null | undefined): GoodsCondition | null {
  return reason && reason in REASON_CONDITION ? REASON_CONDITION[reason as ReasonCode] : null;
}
