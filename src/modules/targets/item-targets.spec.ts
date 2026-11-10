import { ForbiddenException } from '@nestjs/common';

import { ItemTargetsService, pctOf, validateLines } from './item-targets.service';
import { TargetsService } from './targets.service';

/** Item targets: the PUT's rules, the switch, the report's enrichment. */
describe('item targets — the rules of a PUT', () => {
  it('accepts a QTY line with up to 3 decimals and an AMOUNT line in whole fils', () => {
    expect(
      validateLines([
        { itemNumber: 'W1', metric: 'QTY', targetQty: 12.5 },
        { itemNumber: 'W2', metric: 'QTY', targetQty: 0.125 },
        { itemNumber: 'J1', metric: 'AMOUNT', targetFils: 150000 },
      ]),
    ).toEqual([]);
  });

  it('names each problem', () => {
    const p = validateLines([
      { itemNumber: 'A', metric: 'QTY', targetQty: 1.2345 },
      { itemNumber: 'B', metric: 'QTY', targetFils: 5 },
      { itemNumber: 'C', metric: 'AMOUNT', targetFils: 10.5 },
      { itemNumber: 'D', metric: 'AMOUNT', targetQty: 3 },
      { itemNumber: 'E', metric: 'QTY', targetQty: 0 },
      { itemNumber: 'F', metric: 'AMOUNT', targetFils: -1 },
      { itemNumber: 'A', metric: 'QTY', targetQty: 1 },
      { itemNumber: 'G', metric: 'PIECES', targetQty: 1 },
      { itemNumber: ' ', metric: 'QTY', targetQty: 1 },
    ]);
    expect(p).toEqual([
      'A: targetQty has more than 3 decimals',
      'B: a QTY target takes targetQty, not targetFils',
      'B: targetQty must be greater than 0',
      'C: targetFils must be whole fils',
      'D: an AMOUNT target takes targetFils, not targetQty',
      'D: targetFils must be greater than 0',
      'E: targetQty must be greater than 0',
      'F: targetFils must be greater than 0',
      'A: listed twice',
      'G: metric must be QTY or AMOUNT',
      'an item number is required',
    ]);
  });

  it('pct is achieved ÷ target, rounded; 0 without a positive target', () => {
    expect(pctOf(33, 66)).toBe(50);
    expect(pctOf(38280, 38280)).toBe(100);
    expect(pctOf(-2, 10)).toBe(-20);
    expect(pctOf(5, 0)).toBe(0);
    expect(pctOf(5, null)).toBe(0);
  });
});

describe('item targets — switched off', () => {
  function svc(on: boolean) {
    const s = Object.create(ItemTargetsService.prototype) as Record<string, unknown>;
    s.settings = { itemTargetsEnabled: async () => on };
    const query = jest.fn(async () => []);
    s.ds = { query };
    return { s: s as unknown as ItemTargetsService, query };
  }

  it('GET answers { items: [] } without reading the targets', async () => {
    const { s, query } = svc(false);
    expect(await s.list(2026, 11)).toEqual({ items: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('PUT and DELETE answer 403 FEATURE_DISABLED and write nothing', async () => {
    const { s, query } = svc(false);
    const put = await s.replace({ repId: 'r', year: 2026, month: 11, lines: [] }, null).catch((e: unknown) => e);
    expect(put).toBeInstanceOf(ForbiddenException);
    expect((put as ForbiddenException).getResponse()).toEqual({
      code: 'FEATURE_DISABLED',
      message: 'Item targets are turned off in Program features',
    });
    await expect(s.remove('x')).rejects.toBeInstanceOf(ForbiddenException);
    expect(query).not.toHaveBeenCalled();
  });

  it('the monthly report carries itemTargets only while on', async () => {
    const make = (on: boolean) => {
      const t = Object.create(TargetsService.prototype) as Record<string, unknown>;
      t.itemTargets = {
        enabled: async () => on,
        lines: async () => [{ repId: 'r1', itemNumber: 'W1' }, { repId: 'r2', itemNumber: 'J1' }],
      };
      return t as unknown as { withItemTargets(rows: Array<{ repId: string }>, y: number, m: number): Promise<Array<Record<string, unknown>>> };
    };
    const off = await make(false).withItemTargets([{ repId: 'r1' }], 2026, 11);
    expect(off[0]).not.toHaveProperty('itemTargets');
    const on = await make(true).withItemTargets([{ repId: 'r1' }, { repId: 'r3' }], 2026, 11);
    expect(on[0].itemTargets).toEqual([{ repId: 'r1', itemNumber: 'W1' }]);
    expect(on[1].itemTargets).toEqual([]);
  });
});
