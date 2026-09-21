import { BadRequestException, ConflictException } from '@nestjs/common';

import { SyncService } from './sync.service';
import { INTAKE_MAX_ATTEMPTS } from './intake-failure';
import { SyncVoucherDto } from './dto/sync.dto';
import { VoucherInbox } from './entities/voucher-inbox.entity';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * The contract that lets a handset tell a stored document from a lost one.
 *
 * A document whose promotion failed was returned inside a `201 Created`, with
 * the failure buried in a `status` field. A client keying on the HTTP status —
 * the ordinary thing for an HTTP client to do — recorded it as synced and was
 * free to drop its only copy. The sale then existed solely as a `failed` inbox
 * row that nothing retried and nobody read.
 *
 * And the dedupe was `findOne` then `save`: two concurrent replays, which is
 * exactly what an offline-first client produces when a request times out on a
 * dying link but succeeds server-side, both missed and both inserted. The loser
 * got a raw 23505 → 500 → retry, forever.
 */
describe('SyncService — the intake contract', () => {
  const actor: AuthenticatedUser = {
    sub: 'user-1',
    userNumber: 'U-0001',
    userType: 'SALES',
    role: 'viewer',
    repId: 'rep-1',
    permissions: {},
    permKeys: [],
  };

  function row(over: Partial<VoucherInbox> = {}): VoucherInbox {
    return {
      id: 'row-1',
      type: 'VOUCHER',
      clientRef: 'ref-1',
      status: 'pending',
      attempts: 0,
      assignedNumber: 'INV-110101000009',
      payload: {},
      ...over,
    } as VoucherInbox;
  }

  /** Service with no live claim — for exercising the verdict and lookups. */
  function makeSvc(found: VoucherInbox[] = []) {
    const svc = Object.create(SyncService.prototype) as Record<string, unknown>;
    svc.logger = { warn: () => undefined };
    svc.inbox = { find: async () => found };
    return svc as unknown as SyncService;
  }

  // ── The verdict ───────────────────────────────────────────────────────────

  const verdict = (stored: Partial<VoucherInbox>) =>
    (
      makeSvc() as unknown as {
        resultFor(r: VoucherInbox): { status: string; retryable: boolean };
      }
    ).resultFor(row(stored));

  it('reports a failed promotion as rejected, never as success', () => {
    // The whole point: this may NOT read as "stored, carry on".
    expect(verdict({ status: 'failed', error: 'no such customer' })).toMatchObject({
      status: 'rejected',
      retryable: false,
    });
  });

  it('reports a staged-but-unposted document as accepted and retryable', () => {
    // `retryable` is what tells the handset to KEEP its local copy.
    expect(verdict({ status: 'pending' })).toMatchObject({
      status: 'accepted',
      retryable: true,
    });
  });

  it('reports a promoted document as posted', () => {
    expect(verdict({ status: 'posted' })).toMatchObject({
      status: 'posted',
      retryable: false,
    });
  });

  it('reports a burnt-out document as rejected', () => {
    expect(verdict({ status: 'dead_letter' })).toMatchObject({
      status: 'rejected',
      retryable: false,
    });
  });

  it('echoes the clientRef and the app’s own number', () => {
    const r = (
      makeSvc() as unknown as { resultFor(x: VoucherInbox): Record<string, unknown> }
    ).resultFor(row({ clientRef: 'ref-9', clientNumber: 'INV-APP-7' }));
    // Echoed so the app can match without trusting array order, and so a
    // server-renumbered document can still be reconciled against the handset.
    expect(r).toMatchObject({ clientRef: 'ref-9', clientNumber: 'INV-APP-7' });
  });

  // ── The replay ────────────────────────────────────────────────────────────

  it('answers a replay from the existing row instead of inserting again', async () => {
    let inserts = 0;
    const existing = row({ status: 'posted', clientRef: 'ref-1' });
    const svc = Object.create(SyncService.prototype) as Record<string, unknown>;
    svc.logger = { warn: () => undefined };

    const builder = {
      insert: () => builder,
      values: () => builder,
      orIgnore: () => builder,
      returning: () => builder,
      // ON CONFLICT DO NOTHING: an empty RETURNING is the replay path, not an
      // error. It used to surface as a 500 the handset retried forever.
      execute: async () => {
        inserts++;
        return { raw: [] };
      },
    };
    svc.inbox = {
      createQueryBuilder: () => builder,
      findOneByOrFail: async () => existing,
      manager: { query: async () => [{ id: 'rep-1' }] },
    };
    // Reaching these would mean the replay burned a sequence value.
    svc.vouchers = {
      reserveVoucherNumber: async () => {
        throw new Error('a replay must not reserve a voucher number');
      },
      resolveRepVanStore: async () => '110101',
    };

    const res = await (svc as unknown as SyncService).ingestVoucher(
      {
        transKind: 'SALE',
        userCode: 'U-0001',
        clientRef: 'ref-1',
        transactions: [],
      } as unknown as SyncVoucherDto,
      actor,
    );

    expect(inserts).toBe(1);
    expect(res).toMatchObject({ id: 'row-1', status: 'posted', retryable: false });
  });

  // ── Reconciliation ────────────────────────────────────────────────────────

  it('omits a clientRef it has never seen, so the app knows to re-post it', async () => {
    const svc = makeSvc([row({ clientRef: 'ref-known', status: 'posted' })]);
    const res = await svc.statusFor(['ref-known', 'ref-never-arrived'], actor);

    expect(res.items).toHaveLength(1);
    expect(res.items[0].clientRef).toBe('ref-known');
    // Absence is the signal. This is the case the handset previously could not
    // distinguish from success.
    expect(res.items.map((i) => i.clientRef)).not.toContain('ref-never-arrived');
  });

  it('asks only for the caller’s own documents', async () => {
    let where: Record<string, unknown> = {};
    const svc = Object.create(SyncService.prototype) as Record<string, unknown>;
    svc.inbox = {
      find: async (opts: { where: Record<string, unknown> }) => {
        where = opts.where;
        return [];
      },
    };
    await (svc as unknown as SyncService).statusFor(['ref-1'], actor);
    expect(where).toMatchObject({ repId: 'rep-1' });
  });

  it('lets a manager reconcile across reps', async () => {
    let where: Record<string, unknown> = {};
    const svc = Object.create(SyncService.prototype) as Record<string, unknown>;
    svc.inbox = {
      find: async (opts: { where: Record<string, unknown> }) => {
        where = opts.where;
        return [];
      },
    };
    await (svc as unknown as SyncService).statusFor(['ref-1'], {
      ...actor,
      role: 'manager',
      repId: null,
    });
    expect(where).not.toHaveProperty('repId');
  });

  it('returns nothing for an empty ref list without querying', async () => {
    const svc = Object.create(SyncService.prototype) as Record<string, unknown>;
    svc.inbox = {
      find: async () => {
        throw new Error('must not query for an empty list');
      },
    };
    await expect(
      (svc as unknown as SyncService).statusFor(['', '  '], actor),
    ).resolves.toEqual({ items: [] });
  });

  // ── What happens to a document that did not post ──────────────────────────

  describe('the retry policy', () => {
    /** Captures the row patch and any notification, without touching a database. */
    function failing(stored: Partial<VoucherInbox>) {
      const updates: Array<Record<string, unknown>> = [];
      const notified: Array<Record<string, unknown>> = [];
      const svc = Object.create(SyncService.prototype) as Record<string, unknown>;
      svc.logger = { warn: () => undefined, error: () => undefined };
      svc.inbox = {
        update: async (_w: unknown, patch: Record<string, unknown>) => {
          updates.push(patch);
        },
      };
      svc.notifications = {
        notifyManagers: async (n: Record<string, unknown>) => {
          notified.push(n);
        },
      };
      const call = (e: unknown) =>
        (
          svc as unknown as { markFailed(r: VoucherInbox, e: unknown): Promise<void> }
        ).markFailed(row(stored), e);
      return { call, updates, notified };
    }

    it('keeps a retryable document in the queue, with a backoff', async () => {
      const f = failing({ attempts: 0 });
      await f.call(new BadRequestException('Not enough stock of 23232 in store 110101'));

      expect(f.updates[0]).toMatchObject({ status: 'pending', attempts: 1 });
      expect(f.updates[0].nextAttemptAt).toBeInstanceOf(Date);
      // Nobody is interrupted for a document that will resolve itself when the
      // load transfer lands.
      expect(f.notified).toHaveLength(0);
    });

    it('rejects a terminal failure at once instead of burning the budget', async () => {
      const f = failing({ attempts: 0 });
      await f.call(new ConflictException({ code: 'CREDIT_LIMIT_EXCEEDED' }));

      expect(f.updates[0]).toMatchObject({ status: 'rejected', attempts: 1 });
      // A person has to act, so a person is told.
      expect(f.notified[0]).toMatchObject({ kind: 'sync.document_rejected' });
    });

    it('dead-letters a retryable document once the budget is spent', async () => {
      const f = failing({ attempts: INTAKE_MAX_ATTEMPTS - 1 });
      await f.call(new BadRequestException('Not enough stock of 23232'));

      expect(f.updates[0]).toMatchObject({
        status: 'dead_letter',
        attempts: INTAKE_MAX_ATTEMPTS,
      });
      expect(f.notified[0]).toMatchObject({ kind: 'sync.document_dead_letter' });
    });

    it('records the useful half of the error, not the class name', async () => {
      const f = failing({ attempts: 0 });
      await f.call(
        new ConflictException({ code: 'CREDIT_HOLD', message: 'Customer is on hold' }),
      );
      // This string is what the rep and the clerk both read.
      expect(f.updates[0].error).toBe('Customer is on hold');
    });

    it('does not let a failed notification mask the failure it reports', async () => {
      const svc = Object.create(SyncService.prototype) as Record<string, unknown>;
      const updates: Array<Record<string, unknown>> = [];
      svc.logger = { warn: () => undefined, error: () => undefined };
      svc.inbox = {
        update: async (_w: unknown, patch: Record<string, unknown>) => {
          updates.push(patch);
        },
      };
      svc.notifications = {
        notifyManagers: async () => {
          throw new Error('inbox is down');
        },
      };
      await expect(
        (
          svc as unknown as { markFailed(r: VoucherInbox, e: unknown): Promise<void> }
        ).markFailed(row({ attempts: 0 }), new ConflictException({ code: 'CREDIT_HOLD' })),
      ).resolves.toBeUndefined();
      expect(updates[0]).toMatchObject({ status: 'rejected' });
    });
  });
});
