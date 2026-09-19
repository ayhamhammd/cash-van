import { BadRequestException } from '@nestjs/common';

import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';

/**
 * A cheque collection taken on a handset.
 *
 * WHAT WENT WRONG. The van app posted a SINGULAR `cheque` object with no amount
 * on it; this DTO declared only a plural `cheques` array whose entries each
 * carry one. The API refuses a body containing any property it does not declare
 * (forbidNonWhitelisted), so the request was rejected with a 400 before the
 * service ran at all — every cheque a rep collected reached neither VanFlow nor
 * the ERP, and nothing on the phone said so.
 *
 * The app sends the list now. The single form is still ACCEPTED, because the
 * handsets in the field do not all update on the day the server does, and a rep
 * taking cheques on last month's build should start working when this deploys.
 * These pin the folding: the old shape must produce exactly the row the new one
 * does, and must not quietly produce a receipt for nothing.
 */
describe('CollectionsService — the single-cheque form older apps send', () => {
  /** Only the reads `create` performs before it gets to the cheque arithmetic. */
  function svcThatFailsAfterFolding() {
    const svc = Object.create(CollectionsService.prototype) as Record<string, unknown>;
    svc.reps = { findOne: async () => ({ id: 'rep-1' }) };
    svc.customers = { exist: async () => true };
    // The location gate is a different rule with its own tests; here it must
    // simply not stand between the payload and the arithmetic under test.
    svc.proximity = { enforce: async () => undefined };
    // Stop the moment the amount is resolved: everything past it is persistence,
    // and what these tests are about is what the amount and the cheque list
    // BECAME.
    svc.collections = {
      manager: {
        transaction: () => {
          throw new StopHere();
        },
      },
    };
    return svc as unknown as CollectionsService;
  }

  class StopHere extends Error {}

  /** Runs create() and reports what the DTO looked like when it stopped. */
  async function fold(dto: Partial<CreateCollectionDto>) {
    const svc = svcThatFailsAfterFolding();
    const full = { repId: 'rep-1', customerId: 'cust-1', ...dto } as CreateCollectionDto;
    try {
      await svc.create(full);
    } catch (e) {
      if (!(e instanceof StopHere)) throw e;
    }
    return full;
  }

  // Every fixture below carries a number AND a due date because the service now
  // refuses a cheque that identifies neither — see the cases at the end. These
  // tests are about the FOLDING, so they use payloads that get past that gate.
  it('turns one legacy cheque into a list carrying the collection amount', async () => {
    const dto = await fold({
      method: 'cheque',
      amount: 260_325,
      cheque: { bankName: 'Housing Bank', chequeNumber: '556677', dueDate: '2026-11-01' },
    });
    expect(dto.cheques).toEqual([
      { bankName: 'Housing Bank', chequeNumber: '556677', dueDate: '2026-11-01', amount: 260_325 },
    ]);
  });

  it('keeps every field the old app sent', async () => {
    const dto = await fold({
      method: 'cheque',
      amount: 1_000,
      cheque: {
        bankName: 'Arab Bank',
        chequeNumber: '99',
        payee: 'الفردوس',
        dueDate: '2026-12-01',
      },
    });
    // A cheque's bank, number, payee and due date are what the office needs to
    // bank it. Dropping any of them on the way through would leave a receipt
    // nobody can act on.
    expect(dto.cheques?.[0]).toMatchObject({
      bankName: 'Arab Bank',
      chequeNumber: '99',
      payee: 'الفردوس',
      dueDate: '2026-12-01',
      amount: 1_000,
    });
  });

  it('refuses the old form with no amount rather than writing a receipt for zero', async () => {
    // The legacy cheque has no amount of its own, so the collection's is the
    // only one there is. Without it there is nothing to total, and a silent
    // zero-value receipt is worse than a refusal.
    await expect(
      fold({ method: 'cheque', cheque: { chequeNumber: '1' } } as Partial<CreateCollectionDto>),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('leaves a modern payload alone', async () => {
    const dto = await fold({
      method: 'cheque',
      cheques: [
        { amount: 100, chequeNumber: 'A', dueDate: '2026-11-01' },
        { amount: 250, chequeNumber: 'B', dueDate: '2026-11-02' },
      ],
    } as Partial<CreateCollectionDto>);
    // Two cheques, two rows, and the receipt totals them — the legacy path must
    // not collapse or rewrite that.
    expect(dto.cheques).toHaveLength(2);
    expect(dto.cheques?.map((c) => c.amount)).toEqual([100, 250]);
  });

  it('lets the list win when a payload carries both forms', async () => {
    // A transitional build could send both. The list is the richer, explicit
    // one — each entry carries its own amount — so the single cheque must not
    // overwrite it and collapse two cheques into one for the whole total.
    const dto = await fold({
      method: 'cheque',
      amount: 350,
      cheques: [
        { amount: 100, chequeNumber: 'A', dueDate: '2026-11-01' },
        { amount: 250, chequeNumber: 'B', dueDate: '2026-11-02' },
      ],
      cheque: { chequeNumber: 'OLD', dueDate: '2026-11-03' },
    } as Partial<CreateCollectionDto>);
    expect(dto.cheques).toHaveLength(2);
    expect(dto.cheques?.map((c) => c.chequeNumber)).toEqual(['A', 'B']);
  });

  it('still refuses a cheque collection with neither form', async () => {
    await expect(fold({ method: 'cheque', amount: 500 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  // ── The cheque has to identify itself ──────────────────────────────────────
  //
  // The ERP refuses a CHECK receipt with no number or due date, because posting
  // builds the Financial Paper out of exactly those two and cannot invent
  // either. Refusing at intake puts the error in front of the salesman, who is
  // holding the cheque; accepting it means a receipt that dead-letters hours
  // later in an office where nobody can read it.

  it('refuses a cheque with no number', async () => {
    await expect(
      fold({ method: 'cheque', cheques: [{ amount: 100, dueDate: '2026-11-01' }] } as Partial<CreateCollectionDto>),
    ).rejects.toThrow(/chequeNumber/);
  });

  it('refuses a cheque with no due date', async () => {
    await expect(
      fold({ method: 'cheque', cheques: [{ amount: 100, chequeNumber: 'A' }] } as Partial<CreateCollectionDto>),
    ).rejects.toThrow(/dueDate/);
  });

  it('counts whitespace as missing — a blank number identifies nothing', async () => {
    await expect(
      fold({
        method: 'cheque',
        cheques: [{ amount: 100, chequeNumber: '   ', dueDate: '2026-11-01' }],
      } as Partial<CreateCollectionDto>),
    ).rejects.toThrow(/chequeNumber/);
  });

  it('names the offending cheque, not just "a cheque"', async () => {
    // Three in the batch and the second is the bad one: a salesman re-reading
    // all three to find out which is worse than being told.
    await expect(
      fold({
        method: 'cheque',
        cheques: [
          { amount: 100, chequeNumber: 'A', dueDate: '2026-11-01' },
          { amount: 100, dueDate: '2026-11-02' },
          { amount: 100, chequeNumber: 'C', dueDate: '2026-11-03' },
        ],
      } as Partial<CreateCollectionDto>),
    ).rejects.toThrow(/cheque 2/);
  });

  it('refuses the OLD single-cheque form too when it cannot identify the cheque', async () => {
    // The legacy path folds into the same list, so it must meet the same bar —
    // otherwise an older handset writes exactly the receipt the ERP rejects.
    await expect(
      fold({
        method: 'cheque',
        amount: 500,
        cheque: { bankName: 'Arab Bank' },
      } as Partial<CreateCollectionDto>),
    ).rejects.toThrow(/chequeNumber/);
  });

  it('does not touch a cash collection', async () => {
    const dto = await fold({ method: 'cash', amount: 700 });
    expect(dto.cheques).toBeUndefined();
  });
});
