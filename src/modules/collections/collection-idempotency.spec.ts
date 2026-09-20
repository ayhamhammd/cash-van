import { BadRequestException, ConflictException } from '@nestjs/common';

import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';

/**
 * Two defects that cost real money, pinned here.
 *
 * ONE: a collection that commits and then times out is re-sent by the handset,
 * exactly as it should be — and without a clientRef the customer is credited
 * twice for money handed over once. The only trace is two receipts a day apart.
 *
 * TWO: bank transfers were recorded as cash with the reference discarded. The
 * app asked the rep for it, the API would not accept it, so the app dropped it
 * — leaving the ERP nothing to match against the statement.
 */
describe('CollectionsService — idempotency and transfers', () => {
  class StopHere extends Error {}

  /** Stops at the transaction, so these tests see the decisions, not the writes. */
  function makeSvc(existing: Record<string, unknown> | null = null) {
    const svc = Object.create(CollectionsService.prototype) as Record<string, unknown>;
    svc.reps = { findOne: async () => ({ id: 'rep-1', code: '203' }) };
    svc.customers = { exist: async () => true };
    svc.proximity = { enforce: async () => undefined };
    svc.collections = {
      findOne: async () => existing,
      manager: { transaction: () => { throw new StopHere(); } },
    };
    return svc as unknown as CollectionsService;
  }

  const base = { repId: 'rep-1', customerId: 'cust-1' };
  const run = (svc: CollectionsService, dto: Partial<CreateCollectionDto>) =>
    svc.create({ ...base, ...dto } as CreateCollectionDto);

  // ── The double credit ─────────────────────────────────────────────────────

  it('answers a replayed clientRef with 409 naming the original receipt', async () => {
    const svc = makeSvc({ id: 'col-1', collectionNumber: 'C-203-0007' });
    const err = await run(svc, {
      method: 'cash', amount: 25_000, clientRef: 'uuid-1',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    // The handset reads a conflict as success, so it must be told WHICH
    // collection already exists — otherwise it cannot reconcile its outbox.
    expect((err as { response: Record<string, unknown> }).response).toMatchObject({
      code: 'duplicate_client_ref',
      collectionId: 'col-1',
      collectionNumber: 'C-203-0007',
    });
  });

  it('lets a first-time clientRef through to be written', async () => {
    const svc = makeSvc(null);
    // Reaching the transaction is the proof: nothing rejected it on the way.
    await expect(run(svc, { method: 'cash', amount: 25_000, clientRef: 'uuid-new' }))
      .rejects.toBeInstanceOf(StopHere);
  });

  it('does not dedupe when no clientRef is sent — an office receipt has none', async () => {
    const svc = makeSvc({ id: 'col-1' });
    await expect(run(svc, { method: 'cash', amount: 25_000 }))
      .rejects.toBeInstanceOf(StopHere);
  });

  // ── The unreconcilable transfer ───────────────────────────────────────────

  it('refuses a transfer with no bank reference', async () => {
    const svc = makeSvc(null);
    await expect(run(svc, { method: 'transfer', amount: 25_000 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('counts whitespace as no reference — a blank matches nothing on a statement', async () => {
    const svc = makeSvc(null);
    await expect(run(svc, { method: 'transfer', amount: 25_000, transferRef: '   ' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a transfer that carries its reference', async () => {
    const svc = makeSvc(null);
    await expect(run(svc, { method: 'transfer', amount: 25_000, transferRef: 'FT26091234' }))
      .rejects.toBeInstanceOf(StopHere);
  });

  it('asks nothing of cash — the reference rule is for transfers only', async () => {
    const svc = makeSvc(null);
    await expect(run(svc, { method: 'cash', amount: 25_000 }))
      .rejects.toBeInstanceOf(StopHere);
  });

  it('checks the replay BEFORE the transfer rule, so a retry is never re-validated', async () => {
    // A handset retrying a transfer it already sent must get the conflict, not
    // a complaint about a field it did send the first time.
    const svc = makeSvc({ id: 'col-9', collectionNumber: 'C-203-0009' });
    const err = await run(svc, { method: 'transfer', amount: 1, clientRef: 'uuid-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
  });
});
