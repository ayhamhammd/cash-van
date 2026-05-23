import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { ROLES_KEY, Role } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

interface ReqUser {
  role?: string;
  sub?: string;
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true; // No @Roles → open to any authenticated user.
    }

    const req = context.switchToHttp().getRequest<Request & { user?: ReqUser }>();
    // Role lives on the JWT, not on req.user (passport returns AuthenticatedUser).
    // We rely on JwtStrategy to have written it to CLS; read from there or fall back to user.
    const role = (req.user as ReqUser & { role?: string })?.role;

    if (!role || !required.includes(role as Role)) {
      throw new ForbiddenException({
        message: `Role '${role ?? 'unknown'}' is not permitted on this route`,
        code: 'forbidden_role',
        requiredAny: required,
      });
    }
    return true;
  }
}
