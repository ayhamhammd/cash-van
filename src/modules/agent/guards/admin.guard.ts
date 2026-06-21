import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';

/**
 * Restricts the agent endpoints to ADMIN users. Runs after the global
 * JwtAuthGuard, so `req.user` is already populated.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    if (req.user?.userType !== 'ADMIN') {
      throw new ForbiddenException(
        'Admin access required for the report agent.',
      );
    }
    return true;
  }
}
