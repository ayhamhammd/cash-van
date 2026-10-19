import { SetMetadata } from '@nestjs/common';

export const FEATURE_KEY = 'requiredFeature';

/**
 * Gates a route on what the COMPANY bought, which is a different question from
 * what the USER may do. Both are checked, entitlement first: an admin with
 * every permission still cannot use e-invoicing the company never paid for.
 *
 * Keeping them separate is what makes "why can't they invoice?" answerable —
 * one check says the company, the other says the person.
 */
export const RequiresFeature = (feature: string) =>
  SetMetadata(FEATURE_KEY, feature);
