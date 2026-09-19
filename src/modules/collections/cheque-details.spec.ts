import { BadRequestException } from '@nestjs/common';

import { ChequesService } from './cheques.service';
import { UpdateChequeDetailsDto } from './dto/collection-actions.dto';

/**
 * Completing a cheque in the office, and saying what the ERP did about it.
 *
 * "Saved" and "the ERP has it now" are different facts, and only the second one
 * tells the office whether the money is on the books. A screen that reports the
 * first while the receipt is still dead-lettered is how sixteen cheques sat
 * posted-but-paperless without anyone noticing.
 */
function makeSvc(
  cheque: Record<string, unknown>,
  outbox: Partial<{
    findFor: jest.Mock;
    enqueue: jest.Mock;
    retry: jest.Mock;
  }>,
  erpPost: jest.Mock = jest.fn().mockResolvedValue({ ok: true }),
) {
  const cheques = {
    findOne: jest.fn().mockResolvedValue(cheque),
    save: jest.fn().mockImplementation((c: unknown) => Promise.resolve(c)),
  };
  const svc = new ChequesService(
    cheques as never,
    { getUserId: () => 'user-1' } as never,
    {
      findFor: jest.fn().mockResolvedValue(null),
      enqueue: jest.fn().mockResolvedValue(undefined),
      retry: jest.fn(),
      ...outbox,
    } as never,
    { post: erpPost } as never,
  );
  return { svc, cheques, erpPost };
}

const undated = () => ({
  id: 'ch-1',
  collectionId: 'col-1',
  chequeNumber: '4893',
  dueDate: null as string | null,
  bankName: null as string | null,
});

describe('ChequesService.updateDetails', () => {
  it('writes the due date the handset could not send', async () => {
    const { svc, cheques } = makeSvc(undated(), {});
    const out = await svc.updateDetails('ch-1', { dueDate: '2026-11-01' });
    expect(out.cheque.dueDate).toBe('2026-11-01');
    expect(cheques.save).toHaveBeenCalled();
  });

  it('leaves fields the office did not supply alone', async () => {
    // A form that posts only the date must not blank the number it never showed.
    const { svc } = makeSvc(undated(), {});
    const out = await svc.updateDetails('ch-1', { dueDate: '2026-11-01' });
    expect(out.cheque.chequeNumber).toBe('4893');
  });

  it('refuses an empty update rather than reporting a push it did not make', async () => {
    const { svc } = makeSvc(undated(), {});
    await expect(svc.updateDetails('ch-1', {} as UpdateChequeDetailsDto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('retries a dead-lettered receipt and reports that it posted', async () => {
    const retry = jest.fn().mockResolvedValue({ status: 'posted', resultRef: 'RC-2026-00099' });
    const { svc } = makeSvc(undated(), {
      findFor: jest.fn().mockResolvedValue({ id: 'ob-1', status: 'dead_letter' }),
      retry,
    });
    const out = await svc.updateDetails('ch-1', { dueDate: '2026-11-01' });
    expect(retry).toHaveBeenCalledWith('ob-1');
    expect(out.erp).toMatchObject({ action: 'retried', status: 'posted', erpRef: 'RC-2026-00099' });
  });

  it('reports the ERP error when the retry fails again', async () => {
    // The office needs the reason, not a green tick — the date may be wrong too.
    const { svc } = makeSvc(undated(), {
      findFor: jest.fn().mockResolvedValue({ id: 'ob-1', status: 'dead_letter' }),
      retry: jest
        .fn()
        .mockResolvedValue({ status: 'dead_letter', error: 'checkDueDate: required', resultRef: null }),
    });
    const out = await svc.updateDetails('ch-1', { dueDate: 'nonsense' });
    expect(out.erp).toMatchObject({ action: 'retried', status: 'dead_letter' });
    expect(out.erp.message).toMatch(/checkDueDate/);
  });

  describe('a receipt the ERP already posted', () => {
    const posted = () => ({
      findFor: jest
        .fn()
        .mockResolvedValue({ id: 'ob-1', status: 'posted', resultRef: 'RC-2026-00064' }),
      retry: jest.fn(),
    });

    it('does NOT re-push it — that is idempotent and changes nothing', async () => {
      const ob = posted();
      const { svc } = makeSvc(undated(), ob);
      await svc.updateDetails('ch-1', { dueDate: '2026-11-01' });
      expect(ob.retry).not.toHaveBeenCalled();
    });

    it('registers the missing Financial Paper instead', async () => {
      // The sixteen: posted, money booked, no paper. This is the repair.
      const { svc, erpPost } = makeSvc(undated(), posted());
      const out = await svc.updateDetails('ch-1', { dueDate: '2026-11-01' });
      expect(erpPost).toHaveBeenCalledWith(
        'receipts/attach-paper',
        expect.objectContaining({
          externalId: 'col-1',
          checkNumber: '4893',
          checkDueDate: '2026-11-01',
        }),
        'col-1-PAPER',
      );
      expect(out.erp.action).toBe('paper_attached');
      expect(out.erp.erpRef).toBe('RC-2026-00064');
    });

    it('will not try without a due date — the ERP cannot register an undated paper', async () => {
      const { svc, erpPost } = makeSvc({ ...undated(), dueDate: null }, posted());
      const out = await svc.updateDetails('ch-1', { bankName: 'Arab Bank' });
      expect(erpPost).not.toHaveBeenCalled();
      expect(out.erp.action).toBe('already_posted');
      expect(out.erp.message).toMatch(/due date/);
    });

    it('reports an ERP refusal rather than claiming the paper exists', async () => {
      const { svc } = makeSvc(
        undated(),
        posted(),
        jest.fn().mockResolvedValue({ ok: false, error: 'Paper number "4893" already exists' }),
      );
      const out = await svc.updateDetails('ch-1', { dueDate: '2026-11-01' });
      expect(out.erp.action).toBe('already_posted');
      expect(out.erp.message).toMatch(/already exists/);
    });

    it('still saves the cheque when the ERP cannot be reached', async () => {
      // The office typed a real due date off a real cheque. Losing it because a
      // network call failed would make them type it again.
      const { svc, cheques } = makeSvc(
        undated(),
        posted(),
        jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      );
      const out = await svc.updateDetails('ch-1', { dueDate: '2026-11-01' });
      expect(cheques.save).toHaveBeenCalled();
      expect(out.cheque.dueDate).toBe('2026-11-01');
      expect(out.erp.message).toMatch(/ECONNREFUSED/);
    });
  });

  it('queues a collection that was never pushed', async () => {
    const enqueue = jest.fn();
    const { svc } = makeSvc(undated(), { findFor: jest.fn().mockResolvedValue(null), enqueue });
    const out = await svc.updateDetails('ch-1', { dueDate: '2026-11-01' });
    expect(enqueue).toHaveBeenCalledWith('PAYMENT', 'col-1');
    expect(out.erp.action).toBe('queued');
  });

  it('leaves a receipt already on its way alone', async () => {
    // Re-queueing a pending row only resets its backoff.
    const retry = jest.fn();
    const enqueue = jest.fn();
    const { svc } = makeSvc(undated(), {
      findFor: jest.fn().mockResolvedValue({ id: 'ob-1', status: 'pending' }),
      retry,
      enqueue,
    });
    const out = await svc.updateDetails('ch-1', { dueDate: '2026-11-01' });
    expect(retry).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(out.erp.action).toBe('already_queued');
  });
});
