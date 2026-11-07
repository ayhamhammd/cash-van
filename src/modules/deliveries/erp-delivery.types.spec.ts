import { erpErrorCode, erpRefusals, erpWarnings, unwrapList, unwrapRun } from './erp-delivery.types';

/**
 * Reading the ERP's delivery-runs answers tolerantly (contract §A): the same
 * envelopes as sales-invoices, and an error code wherever the ERP put it.
 */
describe('ERP delivery-runs envelopes', () => {
  it('unwraps { success, data: run } and a bare run alike', () => {
    expect(unwrapRun({ success: true, data: { id: 'r1', items: [] } })?.id).toBe('r1');
    expect(unwrapRun({ id: 'r2', items: [] })?.id).toBe('r2');
    expect(unwrapRun({ success: true, data: null })).toBeNull();
    expect(unwrapRun(null)).toBeNull();
  });

  it('unwraps a list from data, items or a bare array', () => {
    expect(unwrapList({ data: [1, 2] })).toEqual([1, 2]);
    expect(unwrapList({ items: [3] })).toEqual([3]);
    expect(unwrapList([4])).toEqual([4]);
    expect(unwrapList({})).toEqual([]);
  });

  it('finds the error code at body.code, body.error.code or body.error', () => {
    expect(erpErrorCode({ code: 'RUN_CLOSED' })).toBe('RUN_CLOSED');
    expect(erpErrorCode({ success: false, error: { code: 'STOP_ALREADY_FINAL', message: 'x' } })).toBe(
      'STOP_ALREADY_FINAL',
    );
    expect(erpErrorCode({ error: 'ITEM_NOT_LOADED' })).toBe('ITEM_NOT_LOADED');
    expect(erpErrorCode('nope')).toBeUndefined();
  });

  it('finds LOAD_REFUSED refusals at the top, in error, or in error.details', () => {
    const r = [{ invoiceNumber: 'INV-1', reason: 'ON_ANOTHER_RUN' }];
    expect(erpRefusals({ code: 'LOAD_REFUSED', refusals: r })).toEqual(r);
    expect(erpRefusals({ error: { code: 'LOAD_REFUSED', refusals: r } })).toEqual(r);
    expect(erpRefusals({ error: { code: 'LOAD_REFUSED', details: r } })).toEqual(r);
    expect(erpRefusals({ error: { code: 'VALIDATION_ERROR', details: [{ path: 'x' }] } })).toEqual([]);
  });

  it('reads create warnings at the top or inside data', () => {
    const w = [{ invoiceNumber: 'INV-9', code: 'ALREADY_PAID' }];
    expect(erpWarnings({ data: { id: 'r', warnings: w } })).toEqual(w);
    expect(erpWarnings({ data: { id: 'r' }, warnings: w })).toEqual(w);
    expect(erpWarnings({ data: { id: 'r' } })).toEqual([]);
  });
});
