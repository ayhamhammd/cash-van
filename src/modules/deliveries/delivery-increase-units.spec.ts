import { ITEMS_AR, LINES_AR, arabicCount, unitOf, withBaseUnits } from './delivery-increase-units';

describe('increase lines — the base unit', () => {
  it('names the unit from units, the code standing in for missing names', () => {
    expect(unitOf({ unit: 'PCE', unit_name_ar: 'قطعة', unit_name_en: 'piece' })).toEqual({
      unit: 'PCE',
      unitNameAr: 'قطعة',
      unitNameEn: 'piece',
    });
    expect(unitOf({ unit: 'KG', unit_name_ar: 'كغم', unit_name_en: null })).toEqual({
      unit: 'KG',
      unitNameAr: 'كغم',
      unitNameEn: 'كغم',
    });
    expect(unitOf({ unit: 'BOX', unit_name_ar: null, unit_name_en: null })).toEqual({
      unit: 'BOX',
      unitNameAr: 'BOX',
      unitNameEn: 'BOX',
    });
  });

  it('corrects only rows stored before the base unit was kept, from the product', async () => {
    const query = jest.fn(async () => [
      { id: 'p1', item_number: 'W1', name_ar: 'ماء', name_en: 'Water', unit: 'PCE', unit_name_ar: 'قطعة', unit_name_en: 'piece' },
    ]);
    const old = { productId: 'p1', skuCode: 'W1', nameAr: 'ماء', nameEn: 'Water', unit: 'carton', qty: 2 };
    const fresh = { productId: 'p2', skuCode: 'J1', nameAr: 'عصير', nameEn: null, unit: 'KG', unitNameAr: 'كغم', unitNameEn: 'kg', qty: 1 };
    const out = await withBaseUnits(query, [old, fresh]);
    expect(out).toEqual([
      { ...old, unit: 'PCE', unitNameAr: 'قطعة', unitNameEn: 'piece' },
      fresh,
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('unit_of_measure'), [['p1']]);
    // Nothing stale: no query at all.
    query.mockClear();
    expect(await withBaseUnits(query, [fresh])).toEqual([fresh]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('Arabic counts', () => {
  it('agree the noun with the number', () => {
    expect(arabicCount(1, ITEMS_AR)).toBe('صنف واحد');
    expect(arabicCount(2, ITEMS_AR)).toBe('صنفان');
    expect(arabicCount(3, ITEMS_AR)).toBe('3 أصناف');
    expect(arabicCount(10, ITEMS_AR)).toBe('10 أصناف');
    expect(arabicCount(11, ITEMS_AR)).toBe('11 صنفاً');
    expect(arabicCount(30, ITEMS_AR)).toBe('30 صنفاً');
    expect(arabicCount(1, LINES_AR)).toBe('بند واحد');
    expect(arabicCount(2, LINES_AR)).toBe('بندان');
    expect(arabicCount(4, LINES_AR)).toBe('4 بنود');
    expect(arabicCount(12, LINES_AR)).toBe('12 بنداً');
  });
});
