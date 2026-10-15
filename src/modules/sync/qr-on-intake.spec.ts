import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { SyncService, type IntakeResult } from './sync.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * The sale's JoFotara QR on the intake reply, and the ask-again endpoint.
 *
 * What the rep experiences: post a sale, and the receipt that prints carries
 * the QR. Before this, nothing requested the QR at all — the sale was queued,
 * pushed on a 30-second timer and mirrored across by a rotating poll, so it
 * reached the handset minutes later and every receipt printed blank.
 *
 * The rules worth pinning are the ones about NOT waiting. The intake reply is
 * what tells a handset whether it may drop its only copy of a document, so
 * nothing about fetching a QR may delay or alter that verdict beyond its
 * budget, and no failure may change it.
 */
const rep = {
  sub: 'u1',
  userNumber: '101',
  userType: 'SALES',
  role: 'salesman',
  repId: 'rep-1',
  permissions: {},
  permKeys: [],
} as AuthenticatedUser;

const posted = (over: Partial<IntakeResult> = {}): IntakeResult => ({
  id: 'i1',
  clientRef: 'c1',
  voucherNumber: 'INV-1',
  clientNumber: null,
  status: 'posted',
  attempts: 1,
  error: null,
  retryable: false,
  ...over,
});

interface Svc {
  withJofotaraQr(r: IntakeResult, transKind?: string): Promise<IntakeResult>;
  jofotaraQrFor(
    v: string,
    a: AuthenticatedUser,
  ): Promise<{ voucherNumber: string; jofotaraQrCode: string | null; jofotaraStatus: string | null }>;
}

function makeSvc(
  opts: {
    autoSubmit?: boolean | null;
    qr?: { qrCode: string | null; status: string | null };
    qrThrows?: boolean;
    snapshot?: {
      userCode: string;
      transKind: string;
      jofotaraQrCode: string | null;
      jofotaraStatus: string | null;
    } | null;
  } = {},
) {
  const svc = Object.create(SyncService.prototype) as Record<string, unknown>;
  const awaitQr = jest.fn(async () => {
    if (opts.qrThrows) throw new Error('ERP unreachable');
    return opts.qr ?? { qrCode: 'QR-1', status: 'SUBMITTED' };
  });
  Object.defineProperty(svc, 'erpOutbox', {
    value: { awaitJofotaraQr: awaitQr },
    configurable: true,
  });
  Object.defineProperty(svc, 'settings', {
    value: { jofotaraAutoSubmit: async () => opts.autoSubmit ?? null },
    configurable: true,
  });
  Object.defineProperty(svc, 'vouchers', {
    value: {
      jofotaraSnapshot: async () =>
        opts.snapshot === undefined
          ? { userCode: '101', transKind: 'SALE', jofotaraQrCode: null, jofotaraStatus: null }
          : opts.snapshot,
    },
    configurable: true,
  });
  Object.defineProperty(svc, 'logger', { value: { warn: jest.fn() }, configurable: true });
  // The intake's own ownership rule, reused by the ask-again endpoint.
  Object.defineProperty(svc, 'resolveActingRep', {
    value: jest.fn(async (code: string) => {
      if (code !== rep.userNumber) throw new ForbiddenException({ code: 'REP_MISMATCH' });
      return { repId: rep.repId, userCode: code };
    }),
    configurable: true,
  });
  return { svc: svc as unknown as Svc, awaitQr };
}

describe('the QR on the intake reply', () => {
  it('is fetched and returned for a posted sale', async () => {
    const { svc } = makeSvc();
    const out = await svc.withJofotaraQr(posted(), 'SALE');
    expect(out.jofotaraQrCode).toBe('QR-1');
    expect(out.jofotaraStatus).toBe('SUBMITTED');
  });

  it('leaves the verdict and the document fields exactly as they were', async () => {
    // The reply is what tells the handset whether it may drop its only copy.
    // Adding a QR to it must not disturb any of that.
    const { svc } = makeSvc();
    const before = posted();
    const after = await svc.withJofotaraQr(before, 'SALE');
    expect(after).toMatchObject({
      id: before.id,
      clientRef: before.clientRef,
      voucherNumber: before.voucherNumber,
      status: 'posted',
      attempts: before.attempts,
      retryable: before.retryable,
      error: null,
    });
  });

  it('is not requested for a document that never gets one', async () => {
    const { svc, awaitQr } = makeSvc();
    for (const kind of ['RETURN', 'ORDER', 'CONTAINER_IN', undefined]) {
      expect((await svc.withJofotaraQr(posted(), kind)).jofotaraQrCode).toBeUndefined();
    }
    expect(awaitQr).not.toHaveBeenCalled();
  });

  it('is not requested for a sale that did not post', async () => {
    // Staged or rejected: there is no invoice at the ERP to have a QR.
    const { svc, awaitQr } = makeSvc();
    await svc.withJofotaraQr(posted({ status: 'accepted' }), 'SALE');
    await svc.withJofotaraQr(posted({ status: 'rejected' }), 'SALE');
    expect(awaitQr).not.toHaveBeenCalled();
  });

  it('does not wait when the ERP’s auto-submit switch is OFF', async () => {
    // With it off the ERP never files the invoice, so no QR will ever exist and
    // waiting would delay every receipt in the company for nothing.
    const { svc, awaitQr } = makeSvc({ autoSubmit: false });
    const out = await svc.withJofotaraQr(posted(), 'SALE');
    expect(awaitQr).not.toHaveBeenCalled();
    expect(out.jofotaraQrCode).toBeUndefined();
  });

  it('still waits when the switch is not known', async () => {
    // NULL means an ERP that has not said, or is too old to. A missing QR on an
    // invoice that WAS filed is worse than a receipt that waited for nothing.
    const { svc, awaitQr } = makeSvc({ autoSubmit: null });
    await svc.withJofotaraQr(posted(), 'SALE');
    expect(awaitQr).toHaveBeenCalled();
  });

  it('reports a sale whose QR is not issued yet without pretending otherwise', async () => {
    const { svc } = makeSvc({ qr: { qrCode: null, status: 'PENDING' } });
    const out = await svc.withJofotaraQr(posted(), 'SALE');
    expect(out.jofotaraQrCode).toBeNull();
    expect(out.jofotaraStatus).toBe('PENDING');
    expect(out.status).toBe('posted'); // the sale is still posted
  });

  it('never turns a posted sale into a failure over a QR', async () => {
    const { svc } = makeSvc({ qrThrows: true });
    const out = await svc.withJofotaraQr(posted(), 'SALE');
    expect(out.status).toBe('posted');
    expect(out.jofotaraQrCode).toBeUndefined();
  });
});

describe('asking again for a sale’s QR', () => {
  it('answers from the voucher, with no ERP call, once the QR is stored', async () => {
    const { svc, awaitQr } = makeSvc({
      snapshot: {
        userCode: '101',
        transKind: 'SALE',
        jofotaraQrCode: 'QR-STORED',
        jofotaraStatus: 'SUBMITTED',
      },
    });
    const out = await svc.jofotaraQrFor('INV-1', rep);
    expect(out.jofotaraQrCode).toBe('QR-STORED');
    expect(awaitQr).not.toHaveBeenCalled();
  });

  it('asks the ERP when the voucher has none yet', async () => {
    const { svc, awaitQr } = makeSvc();
    const out = await svc.jofotaraQrFor('INV-1', rep);
    expect(awaitQr).toHaveBeenCalled();
    expect(out.jofotaraQrCode).toBe('QR-1');
  });

  it('refuses another salesman’s sale', async () => {
    // Scoped by the same rule as posting one. A voucher number is guessable, so
    // without this a rep could read any sale in the company by asking for it.
    const { svc } = makeSvc({
      snapshot: {
        userCode: '999',
        transKind: 'SALE',
        jofotaraQrCode: 'QR-THEIRS',
        jofotaraStatus: 'SUBMITTED',
      },
    });
    await expect(svc.jofotaraQrFor('INV-OTHER', rep)).rejects.toThrow(ForbiddenException);
  });

  it('says not found for a voucher that does not exist', async () => {
    const { svc } = makeSvc({ snapshot: null });
    await expect(svc.jofotaraQrFor('NOPE', rep)).rejects.toThrow(NotFoundException);
  });

  it('does not ask the ERP about a document that never gets a QR', async () => {
    const { svc, awaitQr } = makeSvc({
      snapshot: {
        userCode: '101',
        transKind: 'RETURN',
        jofotaraQrCode: null,
        jofotaraStatus: null,
      },
    });
    const out = await svc.jofotaraQrFor('RET-1', rep);
    expect(awaitQr).not.toHaveBeenCalled();
    expect(out.jofotaraQrCode).toBeNull();
  });

  it('does not ask while auto-submit is off', async () => {
    const { svc, awaitQr } = makeSvc({ autoSubmit: false });
    await svc.jofotaraQrFor('INV-1', rep);
    expect(awaitQr).not.toHaveBeenCalled();
  });
});
