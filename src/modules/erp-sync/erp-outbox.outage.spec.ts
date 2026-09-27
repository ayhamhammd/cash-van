import { ErpOutboxService } from './erp-outbox.service';
import type { ErpOutbox } from './entities/erp-outbox.entity';

/**
 * An ERP outage never kills a document.
 *
 * Six attempts on this backoff are about 55 minutes, and every failure used to
 * spend one — a timeout and a 502 as much as a genuine refusal. So an hour of ERP
 * downtime dead-lettered every sale made in it, and a dead letter is never tried
 * again: the van's stock and the customer's account in the ERP were short of
 * those sales for good. Only the ERP saying "no" may spend the attempts now.
 */
describe('ErpOutboxService — outage versus rejection', () => {
  interface Internals {
    pushOne(row: ErpOutbox): Promise<void>;
  }

  function makeSvc(post: () => Promise<unknown>, calls: unknown = [{ path: 'sales-invoices', body: {} }]) {
    const svc = Object.create(ErpOutboxService.prototype) as Record<string, unknown>;
    svc.logger = { log: () => undefined, warn: () => undefined };
    svc.outbox = { save: async (r: ErpOutbox) => r };
    svc.buildCalls = async () => calls;
    svc.erp = { post };
    return svc as unknown as Internals;
  }

  /** A row on its last attempt: one more spent failure dead-letters it. */
  const lastChance = () =>
    ({ id: 'o-1', kind: 'SALE_INVOICE', ref: 'INV-1', status: 'pending', attempts: 5 }) as ErpOutbox;

  it('keeps retrying through a timeout', async () => {
    const row = lastChance();
    await makeSvc(() => Promise.reject(new Error('The operation was aborted due to timeout'))).pushOne(row);
    expect(row.status).toBe('pending');
    expect(row.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('keeps retrying through a refused connection', async () => {
    const row = lastChance();
    await makeSvc(() => Promise.reject(new TypeError('fetch failed'))).pushOne(row);
    expect(row.status).toBe('pending');
  });

  it('keeps retrying while the ERP answers 502', async () => {
    const row = lastChance();
    await makeSvc(async () => ({ ok: false, status: 502, error: 'Bad Gateway' })).pushOne(row);
    expect(row.status).toBe('pending');
  });

  it('waits for a prerequisite for as long as it takes', async () => {
    const row = lastChance();
    await makeSvc(async () => ({ ok: true }), null).pushOne(row);
    expect(row.status).toBe('pending');
  });

  it('never backs off longer than an hour', async () => {
    const row = { ...lastChance(), attempts: 40 } as ErpOutbox;
    const before = Date.now();
    await makeSvc(() => Promise.reject(new Error('ECONNRESET'))).pushOne(row);
    expect(row.nextAttemptAt!.getTime() - before).toBeLessThanOrEqual(3_600_000 + 1000);
  });

  it('still dead-letters a document the ERP refuses', async () => {
    const row = lastChance();
    await makeSvc(async () => ({ ok: false, status: 422, error: 'SKU_NOT_FOUND' })).pushOne(row);
    expect(row.status).toBe('dead_letter');
    expect(row.error).toBe('SKU_NOT_FOUND');
  });

  it('gives a refused document its attempts before giving up on it', async () => {
    const row = { ...lastChance(), attempts: 1 } as ErpOutbox;
    await makeSvc(async () => ({ ok: false, status: 400, error: 'VALIDATION' })).pushOne(row);
    expect(row.status).toBe('pending');
  });
});

describe('exactQty — quantities reach the ERP as they were moved', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { exactQty } = require('./erp-outbox.service') as typeof import('./erp-outbox.service');

  it('keeps a weighed quantity', () => expect(exactQty('2.500')).toBe(2.5));
  it('keeps three places', () => expect(exactQty('0.125')).toBe(0.125));
  it('removes float noise', () => expect(exactQty(0.1 + 0.2)).toBe(0.3));
  it('passes whole pieces through', () => expect(exactQty('12.000')).toBe(12));
  it('reads nothing as zero', () => expect(exactQty(null)).toBe(0));
});
