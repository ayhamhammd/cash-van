import { topCategoryOf } from './top-category';

describe('topCategoryOf', () => {
  const tree = new Map<string, string | null>([
    ['drinks', null],
    ['soft', 'drinks'],
    ['cola', 'soft'],
    ['snacks', null],
  ]);

  it('climbs from the deepest level to the first', () => {
    expect(topCategoryOf('cola', tree)).toBe('drinks');
    expect(topCategoryOf('soft', tree)).toBe('drinks');
  });

  it('keeps a first-level category as it is', () => {
    expect(topCategoryOf('snacks', tree)).toBe('snacks');
  });

  it('stops at the last category it knows when a parent is missing', () => {
    expect(topCategoryOf('x', new Map([['x', 'gone']]))).toBe('x');
  });

  it('does not loop on a cycle', () => {
    const cyclic = new Map([['a', 'b'], ['b', 'a']]);
    expect(['a', 'b']).toContain(topCategoryOf('a', cyclic));
  });

  it('answers null for an uncategorised product', () => {
    expect(topCategoryOf(null, tree)).toBeNull();
  });
});
