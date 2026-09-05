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
