import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ALLOW_TRACKING_TOKEN } from '../decorators/tracking-token.decorator';
import { DevicesService } from '../../modules/devices/devices.service';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

/**
 * Keeps the long-lived tracking token in its lane.
 *
 * It runs after the JWT guard, so the token is already proven authentic; what
 * is left is whether *this* token may reach *this* route. Two checks:
 *
 *  1. Scope — a tracking token is refused anywhere `@AllowTrackingToken()` is
 *     absent. Deny-by-default, because the cost of forgetting the decorator on
 *     a new telemetry route (a 403) is trivial next to the cost of forgetting
 *     it on a route that reads customers.
 *  2. Revocation — the token is checked against its device row on every call.
 *     A token that never expires needs a live kill switch, and releasing the
 *     device is it. One indexed lookup, on telemetry traffic only.
 *
 * Ordinary session tokens fall straight through both.
 */
@Injectable()
export class TrackingTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly devices: DevicesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user?.trackingJti) return true; // not a tracking token

    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_TRACKING_TOKEN,
      [context.getHandler(), context.getClass()],
    );
    if (!allowed) {
      throw new ForbiddenException({
        code: 'tracking_token_scope',
        message:
          'This device token may only report location. Sign in to do anything else.',
      });
    }

    if (!(await this.devices.isTrackingTokenLive(user.trackingJti))) {
      throw new UnauthorizedException({
        code: 'device_released',
        message: 'This device was released by the office.',
      });
    }

    return true;
  }
}
