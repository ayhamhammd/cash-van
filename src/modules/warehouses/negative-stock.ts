/**
 * Whether a pool may be driven below zero, and what that costs.
 *
 * WHY THIS IS ALLOWED AT ALL. A van's stock is genuinely uncertain between the
 * morning load and the day closing, and the goods on it are real whatever the
 * balance says. Refusing the sale does not prevent it: the rep is standing in a
 * shop holding the item, so he sells it on a paper pad, or tries item codes
 * until one goes through. The refusal only stops the SYSTEM knowing, which is
 * worse than a negative balance somebody can see and fix. This is choosing a
 * visible wrong number over an invisible one.
 *
 * WHY IT IS NOT ALLOWED EVERYWHERE. It costs something real: COGS is taken at a
 * stale cost, inventory shows a negative asset nobody can explain to an auditor,
 * and drift hides instead of being fixed. So it is opt-in per warehouse, and
 * what it produces has to be reported rather than left to be discovered.
 *
 * PURE ON PURPOSE — no NestJS, no repository, no database. The rules are the
 * part worth testing, and they are testable here without standing anything up.
 * The ERP keeps its own copy pure for a sharper reason (the file is imported by
 * client components, and reaching the database from it would pull the db client
 * into the browser bundle); keeping the same shape means the two read alike.
 */

export interface NegativeStockContext {
  /** The warehouse's own `allow_negative_stock` flag. */
  warehouseAllowsNegative: boolean;
  /**
   * Whether the store is a van. A depot or the main store is never permitted,
   * whatever its flag says: if the main store is short, something is wrong and
   * the sale should stop.
   *
   * This is the override the ERP spends on lot- and serial-tracked items, which
   * cash-van does not have. Keep an override here whatever the field, because it
   * is what stops the flag being switched on somewhere it must never apply.
   */
  isVan: boolean;
}

/** True when this pool is permitted to go below zero. */
export function mayGoNegative(ctx: NegativeStockContext): boolean {
  if (!ctx.isVan) return false;
  return ctx.warehouseAllowsNegative;
}

/**
 * What to pass as the non-negative guard at a stock deduction.
 *
 * The inverse of the above, named for the call site so nobody has to invert a
 * boolean in their head at the moment they are reading a stock deduction. Small
 * thing; it is the kind of small thing that causes the bug this file prevents.
 */
export function guardNonNegativeFor(ctx: NegativeStockContext): boolean {
  return !mayGoNegative(ctx);
}

/**
 * The money a negative pool represents, as a positive number.
 *
 * A van short twelve units of something costing 4.000 is carrying a 48.000 hole
 * in the inventory account, and that is the figure finance needs — not the
 * quantity. A pool at or above zero is worth nothing to this report, and an item
 * with no cost recorded returns 0 rather than -0, because -0 prints in a report
 * and reads as a defect.
 */
export function negativeValue(quantity: number, unitCost: number): number {
  if (!Number.isFinite(quantity) || !Number.isFinite(unitCost)) return 0;
  if (quantity >= 0 || unitCost <= 0) return 0;
  return Math.abs(quantity) * unitCost;
}
