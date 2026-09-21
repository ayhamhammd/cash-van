import type { EntityManager } from 'typeorm';

import {
  enqueueOutboxWithin,
  outboxKindForVoucher,
  OUTBOX_KIND_BY_TRANS,
} from './outbox-enqueue';

/**
 * The transactional-outbox primitive.
 *
 * The enqueue used to happen after the voucher's transaction committed, through
 * an in-process event. A crash, a redeploy, or a throw in any of the awaits in
 * between left a posted sale that was never queued for the ERP — and nothing
 * anywhere looked for one. The comment the team left at the old listener said
 * as much: "a voucher that posted but never reached the ERP is invisible until
 * someone remembers to drain that queue."
 *
 * These pin the two properties that make the fix work: it is ONE statement (so
 * it can live inside a transaction it does not own), and it refuses to push
 * back a voucher the ERP gave us in the first place.
 */
describe('outboxKindForVoucher', () => {
  it('maps the van document kinds the ERP accepts', () => {
    expect(outboxKindForVoucher('SALE', 'INV-110101000001')).toBe('SALE_INVOICE');
    expect(outboxKindForVoucher('RETURN', 'RTN-110101000001')).toBe('SALES_RETURN');
    expect(outboxKindForVoucher('ORDER', 'ORD-110101000001')).toBe('SALES_ORDER');
    expect(outboxKindForVoucher('TRANSFER', 'TRF-110101000001')).toBe('STOCK_TRANSFER');
  });

  it('refuses a voucher mirrored IN from the ERP', () => {
    // Pushing one back would hand the ERP its own invoice as a new one. The
    // guard used to live in the listener; it had to move with the logic.
    expect(outboxKindForVoucher('SALE', 'ERP-99001')).toBeNull();
    expect(outboxKindForVoucher('RETURN', 'ERP-99002')).toBeNull();
  });

  it('refuses a kind the ERP has no document for', () => {
    expect(outboxKindForVoucher('PAYMENT', 'RCV-1')).toBeNull();
    expect(outboxKindForVoucher('', 'X-1')).toBeNull();
  });

  it('keeps one map, so the two callers cannot drift apart', () => {
    // ErpSyncService used to own a private copy. VouchersModule cannot import
    // ErpSyncModule (that direction is already taken), which is why this lives
    // in a dependency-free file both can read.
    expect(Object.keys(OUTBOX_KIND_BY_TRANS).sort()).toEqual([
      'IN',
      'ORDER',
      'OUT',
      'RETURN',
      'SALE',
      'TRANSFER',
    ]);
  });
});

describe('enqueueOutboxWithin', () => {
  function fakeEm() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const em = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return [];
      },
    } as unknown as EntityManager;
    return { em, calls };
  }

  it('is a single statement, so it can run in the caller’s transaction', async () => {
    const { em, calls } = fakeEm();
    await enqueueOutboxWithin(em, 'SALE_INVOICE', 'INV-110101000001');

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual(['SALE_INVOICE', 'INV-110101000001']);
  });

  it('upserts on (kind, ref) rather than reading first', async () => {
    const { em, calls } = fakeEm();
    await enqueueOutboxWithin(em, 'SALES_RETURN', 'RTN-1');

    // The old check-then-insert could produce two rows for one document, which
    // then disagreed about status, journal_id and payment_skipped — the fields
    // the dashboard and the reconciliation report read.
    expect(calls[0].sql).toMatch(/ON CONFLICT \(kind, ref\) DO UPDATE/);
    expect(calls[0].sql).not.toMatch(/SELECT/i);
  });

  it('revives a failed or dead-lettered row and leaves a live one alone', async () => {
    const { em, calls } = fakeEm();
    await enqueueOutboxWithin(em, 'SALE_INVOICE', 'INV-2');

    const sql = calls[0].sql;
    // Same semantics the original enqueue had, now expressed in SQL.
    expect(sql).toMatch(/WHEN erp_outbox\.status IN \('failed', 'dead_letter'\) THEN 'pending'/);
    expect(sql).toMatch(/ELSE erp_outbox\.status END/);
    // attempts is NOT reset: a revived dead letter gets one more try, not an
    // unbounded supply of them.
    expect(sql).not.toMatch(/SET[\s\S]*attempts\s*=/);
  });

  it('propagates a failure instead of swallowing it', async () => {
    // The whole point. A sale the ERP will never hear about has not fully
    // happened, so it must take the document down with it.
    const em = {
      query: async () => {
        throw new Error('deadlock detected');
      },
    } as unknown as EntityManager;

    await expect(enqueueOutboxWithin(em, 'SALE_INVOICE', 'INV-3')).rejects.toThrow(
      'deadlock detected',
    );
  });
});
