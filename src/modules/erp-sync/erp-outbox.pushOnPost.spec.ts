import { readFileSync } from 'fs';

import { ErpOutboxService } from './erp-outbox.service';

/**
 * Pushing a just-posted voucher at once, instead of on the next drain tick.
 *
 * The field report this answers: a sale's JoFotara QR took minutes to appear on
 * the handset. The van app holds the receipt for up to 8 seconds waiting for it,
 * but on the interval alone the sale had not even been SENT to the ERP when
 * those 8 seconds expired — ERP_OUTBOX_DRAIN_MS is 30 seconds — so no QR could
 * possibly exist yet and every sale printed without one.
 *
 * The property that matters most here is what this is NOT: it is not where the
 * document is recorded. The outbox row is written inside the voucher's own
 * transaction, so a lost or failed event costs this sale a fast QR and nothing
 * else. The old `onVoucherPosted` listener was removed precisely because it did
 * the ENQUEUE after the commit and so could lose a sale outright; these pin that
 * the fast path cannot bring that failure back.
 */
interface Svc {
  pushPostedVoucher(p: { voucherNumber?: string }): Promise<void>;
}

function makeSvc(
  opts: {
    erpOn?: boolean;
    settingsThrows?: boolean;
    due?: Array<Record<string, unknown>>;
    pushThrows?: boolean;
  } = {},
) {
  const findArgs: Array<Record<string, unknown>> = [];
  const pushed: Array<Record<string, unknown>> = [];

  const args: unknown[] = new Array(17).fill(null);
  args[1] = {
    getErpConfig: async () => {
      if (opts.settingsThrows) throw new Error('API key cannot be decrypted');
      return opts.erpOn === false
        ? { enabled: false }
        : { enabled: true, baseUrl: 'http://erp', apiKey: 'k' };
    },
  };
  args[3] = {
    find: async (q: Record<string, unknown>) => {
      findArgs.push(q);
      return opts.due ?? [];
    },
  };
  const svc = new (ErpOutboxService as unknown as new (...a: unknown[]) => unknown)(
    ...args,
  ) as Record<string, unknown>;
  svc.logger = { warn: jest.fn(), log: jest.fn(), debug: jest.fn() };
  svc.pushOne = jest.fn(async (row: Record<string, unknown>) => {
    if (opts.pushThrows) throw new Error('ERP unreachable');
    pushed.push(row);
  });
  return {
    svc: svc as unknown as Svc,
    findArgs,
    pushed,
    warn: (svc.logger as { warn: jest.Mock }).warn,
  };
}

describe('a posted voucher is pushed to the ERP straight away', () => {
  it('is bound to the event VouchersService actually emits', async () => {
    // The one failure mode with no symptom anywhere: misname the event and this
    // listener simply never runs, the fast path quietly does nothing, and the
    // only evidence is a QR that is slow again. So assert the wiring, and assert
    // it against the emitter rather than against a copy of the string.
    const listeners = Reflect.getMetadata(
      'EVENT_LISTENER_METADATA',
      ErpOutboxService.prototype.pushPostedVoucher,
    ) as Array<{ event: string }>;
    expect(listeners.map((l) => l.event)).toContain('erp.voucher.posted');

    // And the emitter still sends that name, so the two cannot drift apart
    // silently. Reading the source is crude, but it is the only thing that
    // actually connects these two files — there is no shared constant.
    const src = readFileSync(`${__dirname}/../vouchers/vouchers.service.ts`, 'utf8');
    expect(src).toContain("emit('erp.voucher.posted'");
  });

  it('pushes that voucher’s due rows without waiting for the interval', async () => {
    const row = { id: 'o1', ref: 'INV-1', kind: 'SALE_INVOICE' };
    const { svc, pushed } = makeSvc({ due: [row] });

    await svc.pushPostedVoucher({ voucherNumber: 'INV-1' });

    expect(pushed).toEqual([row]);
  });

  it('asks only for THIS voucher, and only for rows actually due', async () => {
    // Scoped to the ref so posting one sale does not drag the whole queue
    // through a synchronous push; and `nextAttemptAt` is respected so a document
    // backing off after a failure is left alone. Without that, one ERP outage
    // would become a tight retry loop for every sale posted during it.
    const { svc, findArgs } = makeSvc();

    await svc.pushPostedVoucher({ voucherNumber: 'INV-7' });

    const where = findArgs[0].where as Record<string, unknown>;
    expect(where.ref).toBe('INV-7');
    expect(where.status).toBe('pending');
    expect(where.nextAttemptAt).toBeDefined();
  });

  it('does nothing when the event carries no voucher number', async () => {
    const { svc, findArgs } = makeSvc();
    await svc.pushPostedVoucher({});
    expect(findArgs).toEqual([]);
  });

  it('does nothing while the ERP connection is off or unreadable', async () => {
    // The drain already explains to the log why rows are waiting; this path
    // staying quiet keeps a deliberately ERP-less site from being told twice.
    const off = makeSvc({ erpOn: false });
    await off.svc.pushPostedVoucher({ voucherNumber: 'INV-2' });
    expect(off.findArgs).toEqual([]);

    const broken = makeSvc({ settingsThrows: true });
    await broken.svc.pushPostedVoucher({ voucherNumber: 'INV-3' });
    expect(broken.findArgs).toEqual([]);
  });

  it('swallows a failure and leaves the document to the drain', async () => {
    // This is an optimisation on top of a durable queue. If it throws out of an
    // event listener it achieves nothing but an unhandled rejection — the row is
    // still pending and the next tick still carries it.
    const { svc, warn } = makeSvc({ due: [{ id: 'o1', ref: 'INV-4' }], pushThrows: true });

    await expect(svc.pushPostedVoucher({ voucherNumber: 'INV-4' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('does not send the same voucher twice when the event is replayed', async () => {
    const row = { id: 'o1', ref: 'INV-5' };
    const { svc, pushed } = makeSvc({ due: [row] });

    await Promise.all([
      svc.pushPostedVoucher({ voucherNumber: 'INV-5' }),
      svc.pushPostedVoucher({ voucherNumber: 'INV-5' }),
    ]);

    expect(pushed).toHaveLength(1);
  });

  it('is free again for the next sale on the same voucher number', async () => {
    // The in-flight guard must not latch: a retried post of the same number has
    // to be pushable again.
    const { svc, pushed } = makeSvc({ due: [{ id: 'o1', ref: 'INV-6' }] });
    await svc.pushPostedVoucher({ voucherNumber: 'INV-6' });
    await svc.pushPostedVoucher({ voucherNumber: 'INV-6' });
    expect(pushed).toHaveLength(2);
  });
});
