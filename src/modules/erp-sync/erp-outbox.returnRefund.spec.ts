import { ErpOutboxService } from './erp-outbox.service';

/**
 * A return tells the ERP how the customer was paid back, so the ERP refunds
 * from the van's cash box exactly when the salesman paid cash
 * (docs/SPEC-cash-returns.md §5.4).
 */
function buildReturn(payments: Array<{ amount: string; paymentType: string }>, damagedWh: string | null = null) {
  const args: any[] = new Array(19).fill(null);
  args[5] = {
    findOne: jest.fn().mockResolvedValue({
      voucherNumber: 'RET-1',
      userCode: '101',
      customerNumber: 'CUST-1',
      referenceVoucherNumber: 'INV-1',
      notes: null,
    }),
  };
  args[6] = { find: jest.fn().mockResolvedValue([{ itemNumber: 'A', itemQty: '2', storeNumber: 'VAN-101' }]) };
  args[11] = { find: jest.fn().mockResolvedValue(payments.map((p) => ({ voucherNumber: 'RET-1', ...p }))) };
  const svc = new (ErpOutboxService as any)(...args) as any;
  svc.idmap = { findOne: jest.fn().mockResolvedValue({ erpCode: 'SI-9' }) };
  svc.customerRef = jest.fn().mockResolvedValue({ customerCode: 'CUST-1' });
  svc.erpSkuResolver = jest.fn().mockResolvedValue(() => 'SKU-A');
  svc.erpQty = jest.fn().mockReturnValue(2);
  svc.settings = { damagedReturnWarehouseCode: jest.fn().mockResolvedValue(damagedWh) };
  return svc.buildReturn('RET-1') as Promise<{ path: string; body: Record<string, unknown> }>;
}

describe('a return pushed to the ERP', () => {
  it('asks for a cash refund from the van when the salesman paid cash', async () => {
    const { path, body } = await buildReturn([{ amount: '5.000', paymentType: 'CASH' }]);
    expect(path).toBe('sales-returns');
    expect(body).toMatchObject({ refundMethod: 'CASH', refundWarehouseCode: 'VAN-101', warehouseCode: 'VAN-101' });
  });

  it('says credit for a credit return — the ERP must not refund it, however the sale was paid', async () => {
    const { body } = await buildReturn([{ amount: '5.000', paymentType: 'CREDIT' }]);
    expect(body.refundMethod).toBe('CREDIT');
    expect(body).not.toHaveProperty('refundWarehouseCode');
  });

  it('says credit for a return with no payment rows (Return-by-item)', async () => {
    const { body } = await buildReturn([]);
    expect(body.refundMethod).toBe('CREDIT');
  });

  it('refunds from the van even when the goods go to the damaged warehouse', async () => {
    const { body } = await buildReturn([{ amount: '5.000', paymentType: 'CASH' }], 'DMG');
    expect(body).toMatchObject({ warehouseCode: 'DMG', refundMethod: 'CASH', refundWarehouseCode: 'VAN-101' });
  });
});
