import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ErpOutboxService } from './erp-outbox.service';
import { SyncVoucherDto } from '../sync/dto/sync.dto';

function buildSale(notes: string | null | undefined) {
  const args: any[] = new Array(12).fill(null);
  args[5] = {
    findOne: jest.fn().mockResolvedValue({
      voucherNumber: 'S-1',
      userCode: '101',
      customerNumber: 'CUST-1',
      inDate: '2026-01-01',
      notes,
    }),
  };
  args[6] = { find: jest.fn().mockResolvedValue([]) };
  args[11] = {
    find: jest.fn().mockResolvedValue([{ voucherNumber: 'S-1', amount: '10.000', paymentType: 'CASH' }]),
  };
  const svc = new (ErpOutboxService as any)(...args) as any;
  svc.customerRef = jest.fn().mockResolvedValue({ customerCode: 'CUST-1' });
  svc.vanStoreOf = jest.fn().mockReturnValue('VAN-1');
  return svc.buildSale('S-1') as Promise<{ body: Record<string, unknown> }>;
}

describe("a rep's note on a sale", () => {
  it('travels to the ERP invoice', async () => {
    const { body } = await buildSale('leave it at the back door');
    expect(body.notes).toBe('leave it at the back door');
  });

  it('is left off the invoice when the rep wrote none', async () => {
    const { body } = await buildSale(null);
    expect(body).not.toHaveProperty('notes');
  });

  it('is accepted from the handset by the strict sync validator', async () => {
    const dto = plainToInstance(SyncVoucherDto, {
      transKind: 'SALE',
      userCode: '101',
      clientRef: '6c1f0a9e-3b0e-4a51-9d1e-0c3f1b2a4d5e',
      notes: 'leave it at the back door',
      transactions: [],
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.filter((e) => e.property === 'notes')).toEqual([]);
    expect(errors.map((e) => e.constraints ?? {}).flatMap(Object.values).join(' ')).not.toMatch(/notes should not exist/);
  });
});
