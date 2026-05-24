import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { UserContextService } from '../../../common/context/user-context.service';

/**
 * v: 2 (introduced in preflight 00.5)
 *   - Adds `role` for dashboard RBAC.
 *   - v: 1 tokens (no `role`) are still accepted; treated as `viewer` so they
 *     can hit read-only endpoints, but role-guarded routes will reject them
 *     and force a re-login.
 */
export interface JwtPayload {
  sub: string;
  v?: number;
  userNumber: string;
  userType: string;
  role?: string;
  /** Field-rep id linked to this user (resolved at login), or null. */
  repId?: string | null;
  permissions: Record<string, boolean>;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly userCtx: UserContextService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('jwt.secret'),
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    // Future-proofing: reject tokens claiming a version we don't know.
    if (payload.v !== undefined && payload.v > 2) {
      throw new UnauthorizedException({
        message: 'Token version not supported',
        code: 'token_outdated',
      });
    }

    const role = payload.role ?? 'viewer';
    const repId = payload.repId ?? null;

    this.userCtx.set({
      userId: payload.sub,
      role,
      repId,
    });

    return {
      sub: payload.sub,
      userNumber: payload.userNumber,
      userType: payload.userType,
      role,
      repId,
      permissions: payload.permissions ?? {},
    };
  }
}
