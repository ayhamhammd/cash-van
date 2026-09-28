import { buildStoreResolver, repeatedStockRows } from './van-stock-snapshot';

describe('repeatedStockRows', () => {
  it('a sound snapshot has no repeats, even with one SKU in many warehouses', () => {
    expect(
      repeatedStockRows([
        { skuId: 's1', skuCode: 'A', warehouseId: 'w1', warehouseName: 'MAIN' },
        { skuId: 's1', skuCode: 'A', warehouseId: 'w2', warehouseName: '3' },
        { skuId: 's2', skuCode: 'B', warehouseId: 'w1', warehouseName: 'MAIN' },
      ]),
    ).toBe(0);
  });

  it('counts a SKU + warehouse row sent twice (the 491 read as 982 on 77)', () => {
    const row = { skuId: 's1', skuCode: 'TEREA', warehouseId: 'w3', warehouseName: '3' };
    expect(repeatedStockRows([row, { ...row }, { ...row, warehouseId: 'w1', warehouseName: 'MAIN' }])).toBe(1);
  });

  it('falls back to SKU code and warehouse name when the ERP sends no ids', () => {
    expect(
      repeatedStockRows([
        { skuCode: 'A', warehouseName: 'MAIN' },
        { skuCode: 'A', warehouseName: 'MAIN' },
      ]),
    ).toBe(1);
  });
});

describe('buildStoreResolver', () => {
  const stores = [
    { whNumber: '11', whName: 'وسام اسماعيل' },
    { whNumber: '99', whName: 'وسام اسماعيل' },
    { whNumber: 'MAIN-0001', whName: 'Main' },
  ];
  const idMap = [{ erpId: 'erp-11', localId: '11' }];

  it('two stores sharing a name: the ERP id decides, whichever order they load in', () => {
    expect(buildStoreResolver(stores, idMap)({ warehouseId: 'erp-11', warehouseName: 'وسام اسماعيل' })?.number).toBe('11');
    expect(buildStoreResolver([...stores].reverse(), idMap)({ warehouseId: 'erp-11', warehouseName: 'وسام اسماعيل' })?.number).toBe('11');
  });

  it('a shared name with no known ERP id matches nothing rather than guessing', () => {
    expect(buildStoreResolver(stores, [])({ warehouseName: 'وسام اسماعيل' })).toBeUndefined();
  });

  it('a unique name still matches when the id map has no row yet', () => {
    expect(buildStoreResolver(stores, [])({ warehouseId: 'erp-main', warehouseName: ' Main ' })?.number).toBe('MAIN-0001');
  });
});
