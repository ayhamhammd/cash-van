/**
 * F10 salesman permission keys (the comma-joined list the mobile app reads).
 *
 * Kept here rather than in VouchersService so AuthService can reference them
 * without importing the voucher module.
 */

/** May apply a discount directly, with no approval step. */
export const PERM_DISCOUNT_DIRECT = 'vouchers.discount.direct';

/** May enter a discount, but it requires manager approval. */
export const PERM_DISCOUNT_APPROVAL = 'vouchers.discount.approval';

/** Prefix key encoding a max direct-discount %, e.g. "vouchers.discount.max:5". */
export const PERM_DISCOUNT_MAX_PREFIX = 'vouchers.discount.max:';

/**
 * Discounts are ungated by owner decision: any salesman may discount any amount
 * with no approval, so the discount always reaches the voucher and the ERP
 * export. The server-side check is gone (see VouchersService), but installed
 * app builds still read these keys to decide whether to SHOW the discount input
 * at all and whether to file an approval request — so the app is handed a key
 * set that reflects the new policy, and the change lands without an APK rebuild.
 *
 * Stored user permissions are left untouched: this is a projection applied on
 * the way out, so re-gating later is a one-line revert with no data migration.
 */
export function effectiveSalesmanPermKeys(stored: string[] | null | undefined): string[] {
  const keys = (stored ?? []).filter(
    (k) => k !== PERM_DISCOUNT_APPROVAL && !k.startsWith(PERM_DISCOUNT_MAX_PREFIX),
  );
  if (!keys.includes(PERM_DISCOUNT_DIRECT)) keys.push(PERM_DISCOUNT_DIRECT);
  return keys;
}
