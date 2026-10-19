import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * Guards the provisioning endpoints the CRM calls.
 *
 * A shared secret rather than a user token, because this creates a COMPANY —
 * an action no customer's own admin should ever be able to reach, however
 * privileged they are inside their own tenant.
 *
 * When the secret is unset the endpoint is not merely unguarded, it is
 * switched OFF. An empty configured secret compared against an empty header
 * would otherwise let anyone on the network create tenants.
 */
@Injectable()
export class InternalSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('internalProvisionSecret') ?? '';
    if (!expected) {
      throw new ServiceUnavailableException(
        'Tenant provisioning is disabled — INTERNAL_PROVISION_SECRET is not set.',
      );
    }

    const req = context.switchToHttp().getRequest<Request>();
    const provided = String(req.headers['x-internal-secret'] ?? '');
    if (!this.matches(provided, expected)) {
      throw new UnauthorizedException('Invalid internal secret');
    }
    return true;
  }

  /** Constant time, so a wrong secret cannot be guessed byte by byte. */
  private matches(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}
