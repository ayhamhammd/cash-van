import { SetMetadata } from '@nestjs/common';

export type UserPermission =
  | 'canMakeVoucher'
  | 'canEditVoucher'
  | 'canAddCustomer'
  | 'canEditCustomerCredit'
  | 'canAddItems'
  | 'canEditExpiry'
  | 'canManageOffers';

export const PERMISSIONS_KEY = 'requiredPermissions';
export const RequirePermissions = (...perms: UserPermission[]) =>
  SetMetadata(PERMISSIONS_KEY, perms);
