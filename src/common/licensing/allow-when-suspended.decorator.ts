import { SetMetadata } from '@nestjs/common';

export const ALLOW_WHEN_SUSPENDED = 'allowWhenSuspended';

/**
 * Lets a route keep working while the company's licence is suspended.
 *
 * Needed because "block writes, keep reads" cannot be decided from the HTTP
 * method alone: signing in is a POST but changes no data, and refusing it locks
 * the customer out of the very records the policy is meant to leave reachable.
 *
 * Use sparingly and only where the route does not modify business data —
 * authentication, session refresh, and exports.
 */
export const AllowWhenSuspended = () => SetMetadata(ALLOW_WHEN_SUSPENDED, true);
