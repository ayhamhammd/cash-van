import { SetMetadata } from '@nestjs/common';

export type UserPermission =
  | 'canMakeVoucher'
  | 'canCreateSale'
  | 'canCreateReturn'
  | 'canMakeCollection'
  | 'canEditVoucher'
  | 'canAddCustomer'
  | 'canEditCustomerCredit'
  | 'canAddItems'
  | 'canEditExpiry'
  | 'canManageOffers'
  | 'canFindCustomers'
  | 'canRequestStock'
  | 'canApproveStockRequest';

export const PERMISSIONS_KEY = 'requiredPermissions';

/** Every listed permission is required (AND). */
export const RequirePermissions = (...perms: UserPermission[]) =>
  SetMetadata(PERMISSIONS_KEY, perms);

export const ANY_PERMISSIONS_KEY = 'requiredAnyPermissions';

/**
 * ANY ONE of the listed permissions is enough (OR).
 *
 * Exists because a single endpoint can legitimately serve two different jobs.
 * Running a lead-finder search is one: the office does it from the prospecting
 * page under `canManageOffers`, and a salesman does the same thing from their
 * phone under `canFindCustomers`. Listing both on RequirePermissions would
 * demand the salesman also be able to manage offers, which is unrelated to
 * anything they do.
 */
export const RequireAnyPermission = (...perms: UserPermission[]) =>
  SetMetadata(ANY_PERMISSIONS_KEY, perms);

export const PERMISSION_KEYS_KEY = 'requiredPermissionKeys';

/**
 * Require a granular DASHBOARD permission key, e.g. `segments.edit`.
 *
 * Separate from [RequirePermissions] because the two describe different people.
 * Those are the salesman's boolean columns on `users`; these are the dotted
 * catalogue an admin ticks for an office user, stored as a jsonb array and
 * carried in the token as `permKeys`.
 *
 * The keys existed and were enforced only in the browser — the sidebar hid an
 * entry the API would still answer. This is what makes them real.
 *
 * Admins pass, as they do on every other gate here.
 */
export const RequirePermissionKeys = (...keys: string[]) =>
  SetMetadata(PERMISSION_KEYS_KEY, keys);
