import type { ItemCart } from './entities/item-cart.entity';

/**
 * An item's sales-tax rate, in whole percent.
 *
 * An item carries the rate in TWO columns: the legacy `tax_percentage` (whole
 * percent) and the VanFlow `tax_rate` (fraction, default 0.16). ERP sync sets
 * NEITHER, so a synced item keeps the entity defaults — tax_rate 0.16 and
 * tax_percentage 0 — and reading only the legacy column charged every sale 0%
 * tax. Prefer the legacy column when it is actually set, fall back to the
 * fraction, and honour EXEMPT over both.
 */
export function itemTaxPercent(i: Pick<ItemCart, 'taxType' | 'taxPercentage' | 'taxRate'>): number {
  if (i.taxType === 'EXEMPT') return 0;
  const legacy = Number(i.taxPercentage) || 0;
  if (legacy > 0) return legacy;
  return (Number(i.taxRate) || 0) * 100;
}
