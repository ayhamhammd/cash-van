import { SetMetadata } from '@nestjs/common';

export const ALLOW_TRACKING_TOKEN = 'allowTrackingToken';

/**
 * Marks a route a long-lived tracking token may reach.
 *
 * That token outlives sign-out by design, so it is the one credential on a
 * handset that a thief inherits by simply keeping the phone. Everything it can
 * touch must therefore be write-only telemetry — never a customer list, a
 * price, or a voucher. The default is deny: `TrackingTokenGuard` rejects these
 * tokens everywhere this decorator is absent, so forgetting it fails closed.
 */
export const AllowTrackingToken = () => SetMetadata(ALLOW_TRACKING_TOKEN, true);
