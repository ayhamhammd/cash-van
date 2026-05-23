import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  PERMISSIONS_KEY,
  UserPermission,
} from '../decorators/permissions.decorator';
import { AuthenticatedUser } from '../decorators/current-user.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserPermission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }

    const req = context
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    const user = req.user;
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }
    if (user.userType === 'ADMIN') {
      return true;
    }
    const missing = required.filter((p) => !user.permissions?.[p]);
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing permission(s): ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
