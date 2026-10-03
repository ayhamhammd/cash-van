import {
  guardNonNegativeFor,
  mayGoNegative,
  negativeValue,
} from './negative-stock';

describe('mayGoNegative', () => {
  it('lets a van that is switched on go below zero', () => {
    expect(mayGoNegative({ warehouseAllowsNegative: true, isVan: true })).toBe(true);
  });

  it('refuses a van that is switched off', () => {
    expect(mayGoNegative({ warehouseAllowsNegative: false, isVan: true })).toBe(false);
  });

  it('refuses the main store even when its flag is on', () => {
    // The override is the point of the function. A depot that is short is not
    // uncertain, it is wrong, and the sale should stop — so the flag must not be
    // able to switch that off from a settings screen.
    expect(mayGoNegative({ warehouseAllowsNegative: true, isVan: false })).toBe(false);
  });

  it('refuses an unknown store, which is never a van', () => {
    expect(mayGoNegative({ warehouseAllowsNegative: false, isVan: false })).toBe(false);
  });
});

describe('guardNonNegativeFor', () => {
  it('is the exact inverse, so a call site never inverts it by hand', () => {
    for (const warehouseAllowsNegative of [true, false]) {
      for (const isVan of [true, false]) {
        const ctx = { warehouseAllowsNegative, isVan };
        expect(guardNonNegativeFor(ctx)).toBe(!mayGoNegative(ctx));
      }
    }
  });
});

describe('negativeValue', () => {
  it('reports the hole a negative pool leaves, as money', () => {
    // Twelve units short of something costing 4.000 is a 48.000 hole in the
    // inventory account. That is the figure finance needs, not the quantity.
    expect(negativeValue(-12, 4)).toBe(48);
  });

  it('is zero for a pool at or above zero', () => {
    expect(negativeValue(0, 4)).toBe(0);
    expect(negativeValue(5, 4)).toBe(0);
  });

  it('returns 0 rather than -0 when no cost is recorded', () => {
    // -0 prints in a report and reads as a defect.
    expect(Object.is(negativeValue(-12, 0), 0)).toBe(true);
  });

  it('is not tripped up by a missing number', () => {
    expect(negativeValue(Number.NaN, 4)).toBe(0);
    expect(negativeValue(-12, Number.NaN)).toBe(0);
  });
});
