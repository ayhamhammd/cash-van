import type { ReturnCandidate } from './candidates';
import {
  compareCandidates,
  missingStrategyInput,
  type ReturnStrategy,
  type StrategyContext,
} from './strategies';

/**
 * Match a return to the sales it came from, when the user named no source
 * voucher. See docs/RETURNS-without-a-sale-voucher.md.
 *
 * Pure — no database, no clock, no randomness. Same input, same plan, always.
 * That is what lets the preview the user approves and the confirm that creates
 * documents be the same computation rather than two similar ones.
 */

/** One line of what the customer wants to return. */
export interface AllocationRequestLine {
  itemNumber: string;
  /** Null for items sold without a unit row — matched against null, not ignored. */
  itemUnitId: string | null;
  quantity: number;
  /** Only for CLOSEST_PRICE. */
  expectedUnitPrice?: number;
}

/** One unit-run taken from a single sale line. */
export interface AllocatedLine {
  voucherNumber: string;
  lineId: string;
  itemNumber: string;
  itemName: string;
  itemUnitId: string | null;
  unitCode: string | null;
  unitName: string | null;
  customerNumber: string | null;
  inDate: string;
  quantity: number;
  /** As sold — the price a refund must use. */
  unitPrice: number;
  /** Pro-rated from the sale line so a partial return refunds a proportional share. */
  discountValue: number;
  taxValue: number;
  netTotal: number;
}

/** What could not be sourced, and why the user must be told. */
export interface UnallocatedLine {
  itemNumber: string;
  itemUnitId: string | null;
  quantity: number;
  reason: string;
}

export interface AllocationPlan {
  strategy: ReturnStrategy;
  lines: AllocatedLine[];
  unallocated: UnallocatedLine[];
  /** How many RETURN vouchers this plan will create — one per source sale. */
  voucherCount: number;
  refundTotal: number;
  taxTotal: number;
  error?: string;
}

/**
 * Split a sale line's money proportionally to the units coming back.
 *
 * Pro-rated rather than recomputed from unit price: the sale may have carried a
 * line discount or a tobacco tax the customer actually paid, and recomputing
 * would refund a number that never appeared on the original document.
 */
function proRate(c: ReturnCandidate, take: number) {
  const share = c.soldQty > 0 ? take / c.soldQty : 0;
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    discountValue: round3(c.discountValue * share),
    taxValue: round3(c.taxValue * share),
    netTotal: round3(c.netTotal * share),
  };
}

/**
 * Walk each requested ITEM over its own sale lines, in the strategy's order,
 * taking what is still returnable from each until the quantity is met.
 *
 * One item can span several vouchers; different items can come from different
 * vouchers. The number of resulting documents is therefore not knowable from
 * the request alone — which is why the caller must preview before confirming.
 */
export function allocateReturn(args: {
  request: AllocationRequestLine[];
  candidates: ReturnCandidate[];
  strategy: ReturnStrategy;
}): AllocationPlan {
  const { request, candidates, strategy } = args;

  const empty: AllocationPlan = {
    strategy,
    lines: [],
    unallocated: [],
    voucherCount: 0,
    refundTotal: 0,
    taxTotal: 0,
  };

  // Validate every line before allocating any: a plan that is half-built and
  // then refused is harder to explain than one that never started.
  for (const req of request) {
    const missing = missingStrategyInput(strategy, {
      expectedUnitPrice: req.expectedUnitPrice,
    });
    if (missing) return { ...empty, error: missing };
  }

  const lines: AllocatedLine[] = [];
  const unallocated: UnallocatedLine[] = [];

  // Consumed across request lines, so the same item requested twice cannot draw
  // the same units twice.
  const consumed = new Map<string, number>();

  for (const req of request) {
    if (req.quantity <= 0) continue;
    const ctx: StrategyContext = { expectedUnitPrice: req.expectedUnitPrice };

    // Keyed on item AND unit: a carton return must not consume a piece line's
    // allowance. Sold-without-a-unit lines match null, they are not a wildcard.
    const pool = candidates
      .filter(
        (c) => c.itemNumber === req.itemNumber && c.itemUnitId === req.itemUnitId,
      )
      .sort(compareCandidates(strategy, ctx));

    let outstanding = req.quantity;

    for (const c of pool) {
      if (outstanding <= 0) break;
      const already = consumed.get(c.lineId) ?? 0;
      const available = c.remaining - already;
      if (available <= 0) continue;

      const take = Math.min(available, outstanding);
      lines.push({
        voucherNumber: c.voucherNumber,
        lineId: c.lineId,
        itemNumber: c.itemNumber,
        itemName: c.itemName,
        itemUnitId: c.itemUnitId,
        unitCode: c.unitCode,
        unitName: c.unitName,
        customerNumber: c.customerNumber,
        inDate: c.inDate,
        quantity: take,
        unitPrice: c.unitPrice,
        ...proRate(c, take),
      });

      consumed.set(c.lineId, already + take);
      outstanding -= take;
    }

    // Stated, never silently short-refunded: a customer returning 10 when only
    // 7 are returnable must be told about the 3 before anything is created.
    if (outstanding > 0) {
      unallocated.push({
        itemNumber: req.itemNumber,
        itemUnitId: req.itemUnitId,
        quantity: outstanding,
        reason: pool.length
          ? 'No sale line with enough still returnable'
          : 'No matching sale found for this item and unit',
      });
    }
  }

  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    strategy,
    lines,
    unallocated,
    voucherCount: new Set(lines.map((l) => l.voucherNumber)).size,
    refundTotal: round3(lines.reduce((s, l) => s + l.netTotal, 0)),
    taxTotal: round3(lines.reduce((s, l) => s + l.taxValue, 0)),
  };
}

/**
 * Run every strategy over the same input, so the screen can answer "why that
 * voucher?" with the alternatives instead of an argument.
 */
export function compareStrategies(args: {
  request: AllocationRequestLine[];
  candidates: ReturnCandidate[];
  strategies: readonly ReturnStrategy[];
}): AllocationPlan[] {
  return args.strategies.map((strategy) =>
    allocateReturn({ request: args.request, candidates: args.candidates, strategy }),
  );
}
