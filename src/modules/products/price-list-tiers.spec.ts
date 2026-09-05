import { pickPriceListTier } from './pricing.service';

/**
 * The van must answer with the tier the ERP would answer with.
 *
 * The ERP's resolver keeps every band whose quantity and date match and then
 * takes the HIGHEST minQty — the most specific tier. The mirror used to store
 * only the cheapest band per item, which is a different rule and a cheaper
 * answer: a list reading "1-9 → 1.000, 10+ → 0.900" sold ONE unit at 0.900.
 */
type Tier = {
  name: string;
  unitPrice: number;
  minQty: number;
  maxQty?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  isActive?: boolean;
};

const RETAIL: Tier = { name: 'retail', unitPrice: 1000, minQty: 1, maxQty: 9 };
/** Same base band with no upper bound, for cases that quote above 9. */
const RETAIL_OPEN: Tier = { name: 'retail', unitPrice: 1000, minQty: 1 };
const BULK: Tier = { name: 'bulk', unitPrice: 900, minQty: 10 };
const ON = new Date('2026-09-05T10:00:00Z');

describe('pickPriceListTier', () => {
  it('charges the retail band for a single unit, not the bulk price', () => {
    expect(pickPriceListTier([RETAIL, BULK], 1, ON)?.name).toBe('retail');
  });

  it('charges the bulk band once the quantity reaches it', () => {
    expect(pickPriceListTier([RETAIL, BULK], 10, ON)?.name).toBe('bulk');
  });

  it('takes the most specific tier rather than the cheapest', () => {
    // An open band that is cheaper than the specific one must NOT win: the ERP
    // sorts on minQty, not on price.
    const cheapOpen: Tier = { name: 'open', unitPrice: 500, minQty: 1 };
    const dearSpecific: Tier = { name: 'specific', unitPrice: 800, minQty: 5 };
    expect(pickPriceListTier([cheapOpen, dearSpecific], 6, ON)?.name).toBe('specific');
  });

  it('ignores a band whose window has not opened', () => {
    const future: Tier = { ...BULK, name: 'future', startDate: '2026-12-01' };
    expect(pickPriceListTier([RETAIL_OPEN, future], 50, ON)?.name).toBe('retail');
  });

  it('ignores a band whose window has closed', () => {
    const expired: Tier = { ...BULK, name: 'expired', endDate: '2026-08-31' };
    expect(pickPriceListTier([RETAIL_OPEN, expired], 50, ON)?.name).toBe('retail');
  });

  it('honours a band on its first and last day', () => {
    const window: Tier = { ...BULK, startDate: '2026-09-05', endDate: '2026-09-05' };
    expect(pickPriceListTier([window], 10, ON)?.name).toBe('bulk');
  });

  it('ignores a deactivated band', () => {
    const off: Tier = { ...BULK, name: 'off', isActive: false };
    expect(pickPriceListTier([RETAIL_OPEN, off], 50, ON)?.name).toBe('retail');
  });

  it('respects an upper bound', () => {
    const capped: Tier = { name: 'capped', unitPrice: 950, minQty: 5, maxQty: 20 };
    // Nothing covers 25: retail stops at 9 and capped stops at 20.
    expect(pickPriceListTier([RETAIL, capped], 25, ON)).toBeNull();
    expect(pickPriceListTier([RETAIL, capped], 20, ON)?.name).toBe('capped');
  });

  it('returns null when no band applies', () => {
    expect(pickPriceListTier([BULK], 1, ON)).toBeNull();
    expect(pickPriceListTier([], 1, ON)).toBeNull();
  });

  it('treats a list with one open band exactly as before', () => {
    const only: Tier = { name: 'flat', unitPrice: 1000, minQty: 1 };
    expect(pickPriceListTier([only], 1, ON)?.name).toBe('flat');
    expect(pickPriceListTier([only], 999, ON)?.name).toBe('flat');
  });
});
