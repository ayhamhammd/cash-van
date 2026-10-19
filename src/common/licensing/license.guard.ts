import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { FEATURE_KEY } from './requires-feature.decorator';
import { ALLOW_WHEN_SUSPENDED } from './allow-when-suspended.decorator';
import { ALLOW_INVALID_LICENSE } from './allow-invalid-license.decorator';
import { LicenseContext } from './license-context.service';
import { LicenseService } from './license.service';
import { UserContextService } from '../context/user-context.service';

/** Reads leave the company's own data reachable; only these change it. */
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Resolves the licence key, then enforces what it grants.
 *
 * A GUARD rather than middleware, and registered FIRST among the global guards,
 * for a specific reason: middleware runs before nestjs-cls has created the
 * async context, so there is nowhere to put the result yet. Guards run inside
 * it, and still ahead of the JWT guard and of the interceptor that binds the
 * tenant to the database connection — which is exactly the window this needs.
 *
 * Two jobs, in order:
 *
 *   1. WHICH COMPANY. Login has no token, and `user_number` is only unique per
 *      company now, so `admin@admin.com` can exist in twenty of them. The key
 *      is the only thing that can say which one to look in. It authenticates
 *      nobody — whoever holds it still has to sign in as a real user of that
 *      company.
 *
 *   2. MAY THEY WORK. What the company bought (features), and whether the
 *      account is settled (writes).
 */
@Injectable()
export class LicenseGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly licenses: LicenseService,
    private readonly ctx: LicenseContext,
    private readonly userCtx: UserContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.licenses.enabled) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const key = String(req.headers['x-license-key'] ?? '').trim();

    if (key) {
      const info = await this.licenses.resolve(key);
      if (info?.tenantId) {
        this.ctx.set(info);
        // Pre-authentication hint ONLY. Once a token exists its `tid` wins —
        // otherwise a real user of one company could send another company's
        // key and shift their own scoping.
        const existing = this.userCtx.get();
        if (!existing?.tenantId) {
          this.userCtx.set({
            userId: existing?.userId ?? '',
            role: existing?.role ?? 'anonymous',
            repId: existing?.repId ?? null,
            tenantId: info.tenantId,
          });
        }
      }
    }

    const info = this.ctx.get();
    // No key presented: health checks, the CRM's own provisioning calls and
    // single-company installs all legitimately arrive without one. The auth
    // guards decide those.
    if (!info) return true;

    // A DEAD key: revoked, or belonging to a company the CRM has suspended
    // outright. Nothing is allowed through — not writes, not reads, not the
    // login itself.
    //
    // This check was missing, and its absence made `revoked` meaningless: the
    // CRM said `valid: false` and this guard read only `features` and
    // `writesAllowed`, so a revoked key behaved exactly like a suspended one.
    // Whoever stole it kept full read access to the company for ever, and the
    // one lever meant to stop them did nothing.
    //
    // Deliberately NOT the same as `suspended` or `expired`. Those are billing
    // states: the customer is still the customer, their records are still
    // theirs, and they keep reading and exporting while writes are paused.
    // `revoked` is the other thing entirely — a key that must stop being a key.
    const allowInvalid = this.reflector.getAllAndOverride<boolean>(
      ALLOW_INVALID_LICENSE,
      [context.getHandler(), context.getClass()],
    );
    if (!info.valid && !allowInvalid) {
      throw new UnauthorizedException({
        message:
          'This licence key is no longer valid. Contact your supplier for a new one.',
        code: 'license_revoked',
        reason: info.reason,
      });
    }

    const required = this.reflector.getAllAndOverride<string>(FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && !info.features.includes(required)) {
      throw new ForbiddenException({
        message: `Your plan does not include ${required}.`,
        code: 'feature_not_licensed',
        feature: required,
      });
    }

    // Unpaid or expired: keep logins, reads and exports working and refuse only
    // writes. A customer locked out of their own accounting records will
    // escalate, and in some jurisdictions those records are legally theirs — a
    // billing problem should not become a bigger one.
    //
    // 402 rather than 403: the caller is permitted, the account is not settled,
    // and a client can tell the two apart to show the right message.
    const alwaysAllowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_WHEN_SUSPENDED,
      [context.getHandler(), context.getClass()],
    );
    if (!info.writesAllowed && !alwaysAllowed && WRITE_METHODS.has(req.method)) {
      throw new HttpException(
        {
          message:
            "This company's licence is suspended or expired. Your data stays " +
            'readable and exportable; changes are paused until it is renewed.',
          code: 'license_inactive',
          reason: info.reason,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return true;
  }
}
