/**
 * F10 salesman permission keys (the comma-joined list the mobile app reads).
 *
 * Kept here rather than in VouchersService so other modules can reference them
 * without importing the voucher module.
 */

/**
 * Shows the discount field in the app's item dialog.
 *
 * This is a UI switch only. The server does NOT reject a discount from a rep
 * who lacks it (see VouchersService.enforceSalesmanPolicy — discounts are
 * ungated there by owner decision); it controls whether the admin lets the rep
 * see the field at all. Permission keys are passed to the app exactly as stored,
 * so toggling it in the dashboard reaches the rep on their next login/refresh.
 */
export const PERM_DISCOUNT_DIRECT = 'vouchers.discount.direct';

/**
 * Legacy: discounts used to be routable through manager approval. That flow is
 * gone — nothing reads this key any more. Retained only so old stored values
 * don't read as unknown.
 */
export const PERM_DISCOUNT_APPROVAL = 'vouchers.discount.approval';

/** Legacy: max direct-discount %, e.g. "vouchers.discount.max:5". No longer enforced. */
export const PERM_DISCOUNT_MAX_PREFIX = 'vouchers.discount.max:';
