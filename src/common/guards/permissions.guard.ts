import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  ANY_PERMISSIONS_KEY,
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
    const requiredAny = this.reflector.getAllAndOverride<UserPermission[]>(
      ANY_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    const hasAny = !!requiredAny && requiredAny.length > 0;
    if ((!required || required.length === 0) && !hasAny) {
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
    if (hasAny && !requiredAny.some((p) => user.permissions?.[p])) {
      throw new ForbiddenException(
        `Requires one of: ${requiredAny.join(', ')}`,
      );
    }
    const missing = (required ?? []).filter((p) => !user.permissions?.[p]);
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing permission(s): ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
