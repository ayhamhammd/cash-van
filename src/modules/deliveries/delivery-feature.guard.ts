import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SettingsService } from '../settings/settings.service';

export const FEATURE_DISABLED = 'FEATURE_DISABLED';
export const DELIVERY_OFF_MESSAGE = 'Delivery & collection is turned off in Program features';

/** The thrown answer, for every route that refuses while the switch is off. */
export function deliveryDisabled(status: 'forbidden' | 'bad-request' = 'forbidden') {
  const body = { code: FEATURE_DISABLED, message: DELIVERY_OFF_MESSAGE };
  return status === 'forbidden'
    ? new ForbiddenException(body)
    : new BadRequestException(body);
}

const ANSWERS_WHEN_OFF = 'delivery:answersWhenOff';

/**
 * A route that stays reachable with the switch off and answers for itself
 * (the sidebar badge counts answer `{ pending: 0 }` rather than an error).
 */
export const AnswersWhenDeliveryOff = () => SetMetadata(ANSWERS_WHEN_OFF, true);

/**
 * The office's delivery screens while Delivery & collection is switched off:
 * 403 FEATURE_DISABLED, except routes marked AnswersWhenDeliveryOff.
 */
@Injectable()
export class DeliveryFeatureGuard implements CanActivate {
  constructor(
    private readonly settings: SettingsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const exempt = this.reflector.getAllAndOverride<boolean>(ANSWERS_WHEN_OFF, [ctx.getHandler(), ctx.getClass()]);
    if (exempt) return true;
    if (await this.settings.deliveryEnabled()) return true;
    throw deliveryDisabled();
  }
}
