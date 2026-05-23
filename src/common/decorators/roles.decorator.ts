import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
export type Role = 'admin' | 'manager' | 'supervisor' | 'viewer';

/**
 * Allow only users whose JWT `role` claim is in the given list.
 *
 *   @Roles('admin', 'manager')
 *   @Post(':id')
 *   update(...) {...}
 *
 * Routes without @Roles are open to all authenticated users (the JWT guard
 * still applies). Combine with the existing @Permissions(...) decorator if
 * you also need a per-action capability check.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
