import type { ProspectStatus } from './entities/prospect.entity';

/** Pipeline order, also used for DTO validation. */
export const PROSPECT_STATUSES = [
  'NEW',
  'QUOTED',
  'CONTACTED',
  'CONVERTED',
  'REJECTED',
] as const satisfies readonly ProspectStatus[];

/**
 * Google Places types offered in the UI. Restricted to an allow-list so an
 * arbitrary string can't be forwarded to the paid Places API.
 */
export const PROSPECT_CATEGORIES = [
  'supermarket',
  'grocery_store',
  'convenience_store',
  'shopping_mall',
  'wholesaler',
  'liquor_store',
  'gas_station',
  'restaurant',
  'cafe',
] as const;

export type ProspectCategory = (typeof PROSPECT_CATEGORIES)[number];
