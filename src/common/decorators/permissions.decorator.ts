import { SetMetadata } from '@nestjs/common';

export type UserPermission =
  | 'canMakeVoucher'
  | 'canEditVoucher'
  | 'canAddCustomer'
  | 'canEditCustomerCredit'
  | 'canAddItems'
  | 'canEditExpiry';

export const PERMISSIONS_KEY = 'requiredPermissions';
export const RequirePermissions = (...perms: UserPermission[]) =>
  SetMetadata(PERMISSIONS_KEY, perms);
