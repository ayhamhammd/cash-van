import { BadRequestException } from '@nestjs/common';

import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { chequeGaps, chequeMissing, describeMissing } from './cheque-gaps';
import { ErpSyncService } from '../erp-sync/erp-sync.service';

/**
 * A cheque with no due date, and the three places that now deal with it.
 *
 * WHAT KEPT HAPPENING. Every handset in the field ran a build with no due-date
 * field, so every cheque reached the server undated, was accepted (rightly —
 * the money was in the salesman's hand), and then dead-lettered on its way to
 * the ERP, which cannot register a paper it cannot identify. The office read
 * "complete it with PATCH /cheques/:id/details" and had no way to do that short
 * of SQL on the server. The dashboard's own form let an office user leave the
 * date out as well.
 */

describe('cheque-gaps — the one rule for "can the ERP register this cheque"', () => {
  it('a numbered, dated cheque is complete', () => {
    expect(chequeMissing({ chequeNumber: '4893', dueDate: '2026-11-30' })).toEqual([]);
  });

  it('names the date when only the date is missing — the shape of every stuck cheque on 94', () => {
    expect(chequeMissing({ chequeNumber: '4893', dueDate: null })).toEqual(['dueDate']);
  });

  it('a blank or whitespace number is no number', () => {
    expect(chequeMissing({ chequeNumber: '   ', dueDate: '2026-11-30' })).toEqual(['chequeNumber']);
  });

  it('accepts a Date object as well as a string for the date column', () => {
    // The driver can hand a `date` column back either way; both are present.
    expect(chequeMissing({ chequeNumber: '1', dueDate: new Date('2026-11-30') })).toEqual([]);
  });

  it('reports every incomplete cheque on a collection, each with its own id', () => {
    const gaps = chequeGaps([
      { id: 'a', chequeNumber: '1', dueDate: '2026-11-30' },
      { id: 'b', chequeNumber: '2', dueDate: null },
      { id: 'c', chequeNumber: null, dueDate: null },
    ]);
    expect(gaps).toEqual([
      { chequeId: 'b', missing: ['dueDate'] },
      { chequeId: 'c', missing: ['chequeNumber', 'dueDate'] },
    ]);
  });

  it('describes the gap in words an office user reads', () => {
    expect(describeMissing(['chequeNumber', 'dueDate'])).toBe('cheque number and due date');
  });
});

describe('CollectionsService.create — who is refused a cheque with no due date', () => {
  class StopHere extends Error {}

  /** A service that stops the moment the cheque checks have passed. */
  function svc() {
    const s = Object.create(CollectionsService.prototype) as Record<string, unknown>;
    s.reps = { findOne: async () => ({ id: 'rep-1' }) };
    s.customers = { exist: async () => true };
    s.proximity = { enforce: async () => undefined };
    s.collections = {
      findOne: async () => null,
      manager: { transaction: () => { throw new StopHere(); } },
    };
    return s as unknown as CollectionsService;
  }

  const undated: Partial<CreateCollectionDto> = {
    method: 'cheque',
    cheques: [{ amount: 1_000, chequeNumber: '4893', bankName: 'Arab Bank' }],
  };

  async function run(dto: Partial<CreateCollectionDto>, opts?: { requireChequeDueDate?: boolean }) {
    const full = { repId: 'rep-1', customerId: 'cust-1', ...dto } as CreateCollectionDto;
    try {
      await svc().create(full, opts);
      return 'saved';
    } catch (e) {
      if (e instanceof StopHere) return 'passed';
      throw e;
    }
  }

  it('the DASHBOARD is refused: its form has a date field, so an empty one is an oversight', async () => {
    await expect(run(undated, { requireChequeDueDate: true })).rejects.toThrow(BadRequestException);
    await expect(run(undated, { requireChequeDueDate: true })).rejects.toThrow(/cheque 1: dueDate/);
  });

  it('a HANDSET is not: refusing it would take money the rep is holding off the books', async () => {
    // The sync path calls create() with no options. The receipt is accepted and
    // waits for its date in the office instead.
    await expect(run(undated)).resolves.toBe('passed');
  });

  it('the dashboard with a dated cheque goes through', async () => {
    const dated = {
      method: 'cheque' as const,
      cheques: [{ amount: 1_000, chequeNumber: '4893', dueDate: '2026-11-30' }],
    };
    await expect(run(dated, { requireChequeDueDate: true })).resolves.toBe('passed');
  });

  it('a missing NUMBER is still refused for everyone, as before', async () => {
    const unnumbered = { method: 'cheque' as const, cheques: [{ amount: 1_000, dueDate: '2026-11-30' }] };
    await expect(run(unnumbered)).rejects.toThrow(/chequeNumber/);
  });
});

describe('ErpSyncService.exportCollection — refuses before queueing a push that must fail', () => {
  function svc(cheques: Array<{ id: string; collectionId: string; chequeNumber: string | null; dueDate: string | null }>) {
    const s = Object.create(ErpSyncService.prototype) as Record<string, unknown>;
    const enqueue = jest.fn();
    s.collections = {
      findOne: async () => ({ id: 'col-1', collectionNumber: 'C-204-000004', status: 'confirmed', method: 'cheque' }),
    };
    s.dataSource = { getRepository: () => ({ find: async () => cheques }) };
    s.outbox = { enqueue };
    return { svc: s as unknown as ErpSyncService, enqueue };
  }

  it('an undated cheque is refused with a code the dashboard opens the form on', async () => {
    const { svc: s, enqueue } = svc([{ id: 'ch-1', collectionId: 'col-1', chequeNumber: '4893', dueDate: null }]);
    const err = await s.exportCollection('col-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'cheque_details_missing',
      collectionId: 'col-1',
      collectionNumber: 'C-204-000004',
      chequeGaps: [{ chequeId: 'ch-1', missing: ['dueDate'] }],
    });
    // The whole point: nothing is queued to dead-letter on the next drain.
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a complete cheque is queued as before', async () => {
    const { svc: s, enqueue } = svc([{ id: 'ch-1', collectionId: 'col-1', chequeNumber: '4893', dueDate: '2026-11-30' }]);
    await expect(s.exportCollection('col-1')).resolves.toEqual({ queued: true });
    expect(enqueue).toHaveBeenCalledWith('PAYMENT', 'col-1');
  });
});
