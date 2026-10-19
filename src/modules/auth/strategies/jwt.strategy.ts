import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';

import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { UserContextService } from '../../../common/context/user-context.service';
import { ACCESS_TOKEN_COOKIE } from '../../../common/auth/auth-cookie';
import { DEFAULT_TENANT_ID } from '../../../common/constants/tenancy';

/** Read the JWT from the httpOnly cookie (browser); the header extractor covers mobile/API. */
const cookieExtractor = (req: Request): string | null => {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[ACCESS_TOKEN_COOKIE] ?? null;
};

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
  /**
   * Tenant this token is scoped to (v: 3+). Absent on older tokens, which
   * resolve to DEFAULT_TENANT_ID — correct for a single-company install, and
   * what every pre-tenancy row was migrated to.
   */
  tid?: string;
  /** Field-rep id linked to this user (resolved at login), or null. */
  repId?: string | null;
  permissions: Record<string, boolean>;
  /** Granular dashboard permission keys. */
  permKeys?: string[];
  /**
   * `tracking` marks the long-lived device token that outlives sign-out. It
   * carries no permissions and `TrackingTokenGuard` confines it to telemetry
   * routes; absent means an ordinary interactive session.
   */
  typ?: 'tracking';
  /** Handset the tracking token belongs to. */
  deviceId?: string;
  jti?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  /** False on a shared deployment: a token with no company is then refused. */
  private readonly fallbackEnabled: boolean;

  constructor(
    config: ConfigService,
    private readonly userCtx: UserContextService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        cookieExtractor,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('jwt.secret'),
    });
    // Read after super(), which is the only place `this` becomes available.
    this.fallbackEnabled = config.get<boolean>('tenantFallbackEnabled') !== false;
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    // Future-proofing: reject tokens claiming a version we don't know.
    if (payload.v !== undefined && payload.v > 3) {
      throw new UnauthorizedException({
        message: 'Token version not supported',
        code: 'token_outdated',
      });
    }

    const role = payload.role ?? 'viewer';
    const repId = payload.repId ?? null;

    // A token with no company. Two very different situations, and collapsing
    // them is how a cross-company leak hid here for days:
    //
    //   - Single-company install: there is one company, DEFAULT is right, and
    //     every token predating tenancy legitimately looks like this.
    //   - Shared deployment: this is a token issued before the tenant claim
    //     existed, or by something that forgot it. Defaulting it silently
    //     scopes a real user of one company to a DIFFERENT company's data —
    //     reads AND writes — with nothing anywhere reporting a problem.
    //
    // `TENANT_FALLBACK_ENABLED=false` is what tells us we are the second kind.
    // There, refuse: a re-login costs seconds and issues a correct token.
    const tenantId = payload.tid ?? (this.fallbackEnabled ? DEFAULT_TENANT_ID : null);
    if (!tenantId) {
      throw new UnauthorizedException({
        message: 'Your session predates company scoping. Please sign in again.',
        code: 'token_missing_tenant',
      });
    }

    this.userCtx.set({ userId: payload.sub, role, repId, tenantId });

    // A tracking token is deliberately stripped of permissions: even if it
    // reached a guarded route, there would be nothing for it to satisfy.
    if (payload.typ === 'tracking') {
      if (!payload.jti) {
        throw new UnauthorizedException({
          message: 'Tracking token is missing its id',
          code: 'tracking_token_invalid',
        });
      }
      return {
        sub: payload.sub,
        userNumber: payload.userNumber,
        userType: payload.userType,
        role,
        repId,
        permissions: {},
        trackingJti: payload.jti,
        deviceId: payload.deviceId,
      };
    }

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
