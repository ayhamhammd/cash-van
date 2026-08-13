import type { ReturnCandidate } from './candidates';

/**
 * The order in which an item's past sales are walked when a return names no
 * source voucher.
 *
 * See docs/RETURNS-without-a-sale-voucher.md. The strategy decides ONLY the
 * order; the allocator then walks that order taking what is still returnable
 * from each sale in turn. Mirrors the ERP's `src/lib/sales/returns/strategies.ts`
 * so the two systems can be compared line for line.
 *
 * ## The tie-break is load-bearing
 *
 * "Newest first" is ambiguous the moment two sales share a date — routine for a
 * van, where a salesman raises a dozen vouchers in one morning. The walk order
 * IS the outcome: with an ambiguous order the preview and the confirm can walk
 * differently, so the user approves "6 from V-1, 4 from V-2" and the system
 * creates the reverse, at different prices.
 *
 * Every comparator therefore ends with the same stable tie-break — voucher
 * number, then line id, both unique and immutable. [compareCandidates] appends
 * it centrally rather than trusting each strategy to remember, because a
 * strategy that forgot would pass every test and fail only on a busy day.
 */
export const RETURN_STRATEGIES = [
  'NEWEST_FIRST',
  'OLDEST_FIRST',
  'CLOSEST_PRICE',
  'LARGEST_REMAINING',
] as const;

export type ReturnStrategy = (typeof RETURN_STRATEGIES)[number];

/** What each strategy is for, in the words a user would pick it by. */
export const STRATEGY_RATIONALE: Record<ReturnStrategy, { ar: string; en: string }> = {
  NEWEST_FIRST: {
    ar: 'يطابق أحدث فاتورة أولًا. الخيار المعتاد — العميل غالبًا اشترى البضاعة مؤخرًا، ويُرجَع بآخر سعر بيع.',
    en: 'Match the most recent sale first. The usual choice — a customer returning goods normally bought them recently, and it refunds the most recently charged price.',
  },
  OLDEST_FIRST: {
    ar: 'يطابق أقدم فاتورة أولًا. يُصفّي الفواتير القديمة، ومع ارتفاع الأسعار يُرجَع بالسعر الأقدم الأقل.',
    en: 'Match the oldest open sale first. Clears aged lines and, where prices have risen, refunds the lower historical price.',
  },
  CLOSEST_PRICE: {
    ar: 'يطابق الفاتورة الأقرب سعرًا لما يقول العميل إنه دفعه. الأعدل حين بيع الصنف بأسعار مختلفة.',
    en: 'Match the sale whose unit price is nearest what the customer says they paid. The fairest answer when the same item sold at different prices.',
  },
  LARGEST_REMAINING: {
    ar: 'يطابق الفاتورة الأكثر كمية قابلة للإرجاع. يوزّع الإرجاع على أقل عدد من المستندات.',
    en: 'Match the sale with the most units still returnable. Spreads a return across the fewest documents.',
  },
};

/** Context a strategy may need beyond the candidate itself. */
export interface StrategyContext {
  /**
   * What the customer says they paid per unit — required by CLOSEST_PRICE and
   * by nothing else. [missingStrategyInput] refuses rather than quietly falling
   * back to another ordering: a silent fallback would produce a plan the user
   * did not ask for, indistinguishable from one they did.
   */
  expectedUnitPrice?: number;
}

/** Names the missing input for a strategy that needs one, or null. */
export function missingStrategyInput(
  strategy: ReturnStrategy,
  ctx: StrategyContext,
): string | null {
  if (strategy === 'CLOSEST_PRICE' && ctx.expectedUnitPrice === undefined) {
    return 'CLOSEST_PRICE needs the price the customer says they paid (expectedUnitPrice).';
  }
  return null;
}

type Comparator = (a: ReturnCandidate, b: ReturnCandidate) => number;

/** Voucher number, then line id. Unique and immutable → a total order. */
const stableTieBreak: Comparator = (a, b) =>
  a.voucherNumber.localeCompare(b.voucherNumber) || a.lineId.localeCompare(b.lineId);

const BY_STRATEGY: Record<ReturnStrategy, (ctx: StrategyContext) => Comparator> = {
  NEWEST_FIRST: () => (a, b) => b.inDate.localeCompare(a.inDate),
  OLDEST_FIRST: () => (a, b) => a.inDate.localeCompare(b.inDate),
  CLOSEST_PRICE: (ctx) => (a, b) =>
    Math.abs(a.unitPrice - (ctx.expectedUnitPrice ?? 0)) -
    Math.abs(b.unitPrice - (ctx.expectedUnitPrice ?? 0)),
  LARGEST_REMAINING: () => (a, b) => b.remaining - a.remaining,
};

/**
 * The comparator for a strategy, with the stable tie-break already appended.
 *
 * Always use this rather than the raw strategy comparator — the tie-break is
 * what makes the allocator a function in the mathematical sense.
 */
export function compareCandidates(
  strategy: ReturnStrategy,
  ctx: StrategyContext = {},
): Comparator {
  const primary = BY_STRATEGY[strategy](ctx);
  return (a, b) => primary(a, b) || stableTieBreak(a, b);
}
