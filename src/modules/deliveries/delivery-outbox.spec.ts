import { ErpOutboxService } from '../erp-sync/erp-outbox.service';
import type { ErpOutbox } from '../erp-sync/entities/erp-outbox.entity';
import { DeliveryIntakeService } from './delivery-intake.service';

/**
 * DELIVERY_RESULT through the existing outbox drain: the deliveries module's
 * handler builds the call, a 409 STOP_ALREADY_FINAL / RUN_CLOSED dead-letters
 * at once, and an accepted result mirrors the run the ERP answered with.
 */
describe('outbox — DELIVERY_RESULT', () => {
  const payload = {
    clientRef: 'd-1',
    stopId: 'stop-1',
    erpItemId: 'item-9',
    runErpId: 'run-1',
    outcome: 'DELIVERED',
    deliveredAt: '2026-11-08T07:42:00.000Z',
  };

  function setup(reply: { ok: boolean; status: number; data?: unknown; error?: string }) {
    const mirror = {
      applyRun: jest.fn().mockResolvedValue({}),
      pullRun: jest.fn().mockResolvedValue({}),
      settleRef: jest.fn().mockResolvedValue(null),
      signal: jest.fn(),
    };
    const ds = {
      query: async (sql: string) => {
        if (sql.includes('SELECT payload FROM voucher_inbox')) return [{ payload }];
        if (sql.includes('SELECT r.erp_id')) return [{ erp_id: 'run-1' }];
        throw new Error(`unexpected SQL ${sql}`);
      },
    };
    const outbox = Object.create(ErpOutboxService.prototype) as Record<string, unknown>;
    outbox.handlers = new Map();
    outbox.logger = { log: () => undefined, warn: () => undefined };
    outbox.outbox = { save: async (r: ErpOutbox) => r, findOne: async () => null };
    outbox.erp = { post: jest.fn().mockResolvedValue(reply) };
    outbox.requeuedSinceRead = async () => false;
    const intake = new DeliveryIntakeService(ds as never, {} as never, mirror as never, outbox as never);
    intake.onModuleInit();
    const row = { id: 'o-1', kind: 'DELIVERY_RESULT', ref: 'd-1', status: 'pending', attempts: 0 } as ErpOutbox;
    const push = () => (outbox as unknown as { pushOne(r: ErpOutbox): Promise<void> }).pushOne(row);
    return { outbox, mirror, row, push, post: outbox.erp as { post: jest.Mock } };
  }

  it('posts the result with externalId = clientRef as the Idempotency-Key', async () => {
    const run = { id: 'run-1', items: [] };
    const t = setup({ ok: true, status: 200, data: { success: true, data: run } });
    await t.push();
    expect(t.post.post).toHaveBeenCalledWith(
      'delivery-runs/items/item-9/result',
      { externalId: 'd-1', outcome: 'DELIVERED', deliveredAt: '2026-11-08T07:42:00.000Z' },
      'd-1',
    );
    expect(t.row.status).toBe('posted');
    // The answered run is mirrored and the stop settled.
    expect(t.mirror.applyRun).toHaveBeenCalledWith(run, { settledRef: 'd-1' });
  });

  it('re-reads the run when the reply carries none', async () => {
    const t = setup({ ok: true, status: 200, data: { success: true } });
    await t.push();
    expect(t.mirror.pullRun).toHaveBeenCalledWith('run-1', { settledRef: 'd-1' });
    expect(t.mirror.settleRef).toHaveBeenCalledWith('d-1');
  });

  it.each(['STOP_ALREADY_FINAL', 'RUN_CLOSED'])('409 %s is terminal: dead letter, SENDING cleared, run re-read', async (code) => {
    const t = setup({ ok: false, status: 409, data: { success: false, error: { code } }, error: code });
    await t.push();
    expect(t.row.status).toBe('dead_letter');
    expect(t.row.attempts).toBe(1);
    expect(t.mirror.settleRef).toHaveBeenCalledWith('d-1');
    expect(t.mirror.pullRun).toHaveBeenCalledWith('run-1');
  });

  it('any other refusal retries as usual', async () => {
    const t = setup({ ok: false, status: 404, data: { error: { code: 'NOT_FOUND' } }, error: 'NOT_FOUND' });
    await t.push();
    expect(t.row.status).toBe('pending');
    expect(t.mirror.settleRef).not.toHaveBeenCalled();
  });

  it('an ERP outage retries and keeps the stop SENDING', async () => {
    const t = setup({ ok: false, status: 503, error: 'down' });
    await t.push();
    expect(t.row.status).toBe('pending');
    expect(t.mirror.settleRef).not.toHaveBeenCalled();
  });
});

describe('PAYMENT — a collection against an ERP invoice', () => {
  function makeSvc(mocks: Record<number, unknown>): ErpOutboxService {
    const args: unknown[] = new Array(16).fill(null);
    for (const [i, v] of Object.entries(mocks)) args[Number(i)] = v;
    return new (ErpOutboxService as unknown as new (...a: unknown[]) => ErpOutboxService)(...args);
  }
  const one = (row: unknown) => ({ findOne: jest.fn().mockResolvedValue(row) });
  const build = (col: Record<string, unknown>) =>
    (
      makeSvc({
        4: one(null),
        8: one({ id: 'col-1', customerId: 'cust-1', repId: 'rep-1', amount: 5000, method: 'cash', note: null, ...col }),
        9: one({ id: 'cust-1', customerNumber: '463' }),
        14: one({ id: 'rep-1', code: 'D01' }),
      }) as unknown as { buildPayment(id: string): Promise<{ body: Record<string, unknown> }> }
    ).buildPayment('col-1');

  it('sends erpInvoiceNumber as invoiceNumber', async () => {
    const out = await build({ erpInvoiceNumber: 'INV-2026-000123' });
    expect(out.body.invoiceNumber).toBe('INV-2026-000123');
    expect(out.body.amount).toBe(5);
  });

  it('sends no invoiceNumber when the collection names none (FIFO as before)', async () => {
    const out = await build({ erpInvoiceNumber: null });
    expect(out.body).not.toHaveProperty('invoiceNumber');
  });
});
