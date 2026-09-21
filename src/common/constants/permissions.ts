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

/**
 * May raise a document that belongs to a DIFFERENT salesman — an office user
 * creating a voucher or collection on a rep's behalf, or replaying a stuck
 * handset document from the dashboard.
 *
 * Without it, the acting rep is always the one the caller's own token names.
 * That is the whole authorization story for `/sync/*`: the request body used to
 * decide whose van the goods left and whose settlement the money landed in, and
 * nothing compared it to the token. See docs/SPEC-dashboard-voucher-on-behalf.md.
 */
export const PERM_ON_BEHALF = 'vouchers.createOnBehalf';

/**
 * When acting on behalf, may proceed past a policy the TARGET rep would have
 * needed approval for. Recorded on the document when used — an override that
 * leaves no trace is the same as no rule.
 */
export const PERM_POLICY_OVERRIDE = 'vouchers.overrideSalesmanPolicy';
