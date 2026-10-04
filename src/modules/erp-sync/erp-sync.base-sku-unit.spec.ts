import { ErpSyncService } from './erp-sync.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- hand-built service, see below */

/**
 * An ERP SKU lands in the pool its item reads.
 *
 * Reported on item 442: a unit row left from an earlier sync still claimed SKU
 * 442 — the item's own base SKU — and was flagged as a variant. Every movement
 * of SKU 442 went into that row's pool, so the base "حبة" showed 0 in the main
 * store while a second "حبة" held 2,105.
 *
 * Constructor arg order (0-indexed): items(3), itemUnits(9), idmap(17).
 */
function makeSvc(unitRow: any, item: any) {
  const args: any[] = new Array(23).fill(null);
  args[3] = { findOne: jest.fn().mockResolvedValue(item) };
  args[9] = { findOne: jest.fn().mockResolvedValue(unitRow) };
  args[17] = { findOne: jest.fn().mockResolvedValue(null) };
  return new (ErpSyncService as any)(...args) as any;
}

const item442 = { id: 'item-442', itemNumber: '442' };

describe('resolveStockTarget', () => {
  it('sends the item’s own base SKU to the base pool, even when a stale unit row claims it', async () => {
    const stale = { id: 'iu-1', isStockUnit: true, qty: 1, unit: { code: 'حبة' }, item: item442 };
    const svc = makeSvc(stale, item442);
    expect(await svc.resolveStockTarget('442')).toEqual({
      itemNumber: '442', itemUnitId: null, stockUnitCode: '', unitBaseQty: 1,
    });
  });

  it('still sends a real variant SKU to the variant’s own pool', async () => {
    const red = { id: 'iu-red', isStockUnit: true, qty: 1, unit: { code: 'احمر' }, item: item442 };
    const svc = makeSvc(red, null);
    expect(await svc.resolveStockTarget('442-RED')).toEqual({
      itemNumber: '442', itemUnitId: 'iu-red', stockUnitCode: 'احمر', unitBaseQty: 1,
    });
  });

  it('sends a pack SKU into the base pool with its piece count', async () => {
    const carton = { id: 'iu-ctn', isStockUnit: false, qty: 12, unit: { code: 'كرتونة' }, item: item442 };
    const svc = makeSvc(carton, null);
    expect(await svc.resolveStockTarget('442-CTN')).toEqual({
      itemNumber: '442', itemUnitId: 'iu-ctn', stockUnitCode: '', unitBaseQty: 12,
    });
  });
});
