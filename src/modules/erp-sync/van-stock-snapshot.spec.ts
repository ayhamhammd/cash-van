import { repeatedStockRows } from './van-stock-snapshot';

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
