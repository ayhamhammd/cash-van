import { ErpOutboxService } from './erp-outbox.service';

/**
 * Asking the ERP for ONE sale's JoFotara QR, for the receipt about to print.
 *
 * This is the request the sync intake makes the moment a sale is saved. The
 * background poll reaches a given voucher once per rotation — minutes, on a
 * database with a few hundred QR-less sales — whereas asking about one invoice
 * by number is a single request that answers at once.
 *
 * Two properties carry the whole design. It is BOUNDED: a QR that has not been
 * issued is a normal answer, because the ERP files with the government
 * asynchronously, so past the deadline the receipt prints without one and the
 * poll fills it in later. And it cannot hurt the sale: the voucher is already
 * saved before this runs, so every failure here resolves to "no QR yet".
 */
interface Svc {
  awaitJofotaraQr(
    v: string,
    ms: number,
  ): Promise<{ qrCode: string | null; status: string | null }>;
}

function makeSvc(opts: {
  stored?: { jofotaraQrCode?: string | null; jofotaraStatus?: string | null } | null;
  invoiceNumber?: string | null;
  erpRows?: Array<{
    invoiceNumber: string;
    jofotaraStatus?: string | null;
    jofotaraQrCode?: string | null;
  }>;
  erpThrows?: boolean;
  erpOn?: boolean;
} = {}) {
  const asked: string[] = [];
  const updates: Array<Record<string, unknown>> = [];

  const args: unknown[] = new Array(17).fill(null);
  args[0] = {
    list: async (_p: string, params: { number: string }) => {
      if (opts.erpThrows) throw new Error('ERP unreachable');
      asked.push(params.number);
      return { data: opts.erpRows ?? [] };
    },
  };
  args[1] = {
    getErpConfig: async () =>
      opts.erpOn === false
        ? { enabled: false }
        : { enabled: true, baseUrl: 'http://erp', apiKey: 'k' },
  };
  args[4] = {
    findOne: async () =>
      opts.invoiceNumber === null ? null : { erpCode: opts.invoiceNumber ?? 'SI-1' },
  };
  args[5] = {
    findOne: async () => (opts.stored === undefined ? {} : opts.stored),
    update: async (where: unknown, patch: unknown) => {
      updates.push({ where, patch });
    },
  };
  const svc = new (ErpOutboxService as unknown as new (...a: unknown[]) => unknown)(
    ...args,
  ) as Record<string, unknown>;
  svc.logger = { warn: jest.fn(), log: jest.fn(), debug: jest.fn() };
  // The event listener normally has the push in flight already; the unit under
  // test here is the QR request, not the push.
  svc.pushPostedVoucher = jest.fn(async () => undefined);
  return {
    svc: svc as unknown as Svc,
    asked,
    updates,
    push: svc.pushPostedVoucher as jest.Mock,
    warn: (svc.logger as { warn: jest.Mock }).warn,
  };
}

describe('the direct JoFotara QR request', () => {
  it('pushes the sale first, because no QR can exist before the ERP has it', async () => {
    const { svc, push } = makeSvc({ stored: { jofotaraQrCode: 'QR-1' } });
    await svc.awaitJofotaraQr('INV-1', 2000);
    expect(push).toHaveBeenCalledWith({ voucherNumber: 'INV-1' });
  });

  it('answers from the voucher without troubling the ERP when the QR is already there', async () => {
    // The common case once the push reply carries the QR: this costs one read.
    const { svc, asked } = makeSvc({ stored: { jofotaraQrCode: 'QR-1', jofotaraStatus: 'SUBMITTED' } });
    const got = await svc.awaitJofotaraQr('INV-1', 2000);
    expect(got).toEqual({ qrCode: 'QR-1', status: 'SUBMITTED' });
    expect(asked).toEqual([]);
  });

  it('asks the ERP about that one invoice when the voucher has no QR yet', async () => {
    const { svc, asked } = makeSvc({
      stored: { jofotaraQrCode: null },
      invoiceNumber: 'SI-500',
      erpRows: [{ invoiceNumber: 'SI-500', jofotaraStatus: 'SUBMITTED', jofotaraQrCode: 'QR-500' }],
    });

    const got = await svc.awaitJofotaraQr('INV-2', 2000);

    expect(got.qrCode).toBe('QR-500');
    expect(asked).toEqual(['SI-500']); // by number, not a batch
  });

  it('writes what it found onto the voucher, so the next read is free', async () => {
    const { svc, updates } = makeSvc({
      stored: { jofotaraQrCode: null },
      invoiceNumber: 'SI-501',
      erpRows: [{ invoiceNumber: 'SI-501', jofotaraQrCode: 'QR-501' }],
    });
    await svc.awaitJofotaraQr('INV-3', 2000);
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toEqual({ jofotaraQrCode: 'QR-501' });
  });

  it('never takes another invoice’s QR on a substring match', async () => {
    // The ERP matches `number` as a substring, so the page can hold SI-120 for
    // a question about SI-12. Copying the wrong QR onto a receipt is worse than
    // printing none, and this path shares the poll's matching for that reason.
    const { svc } = makeSvc({
      stored: { jofotaraQrCode: null },
      invoiceNumber: 'SI-12',
      erpRows: [{ invoiceNumber: 'SI-120', jofotaraQrCode: 'QR-OF-120' }],
    });
    const got = await svc.awaitJofotaraQr('INV-4', 300);
    expect(got.qrCode).toBeNull();
  });

  it('gives up inside its budget when the QR is not issued yet', async () => {
    const { svc } = makeSvc({
      stored: { jofotaraQrCode: null },
      invoiceNumber: 'SI-502',
      erpRows: [{ invoiceNumber: 'SI-502', jofotaraStatus: 'PENDING', jofotaraQrCode: null }],
    });

    const began = Date.now();
    const got = await svc.awaitJofotaraQr('INV-5', 600);
    const took = Date.now() - began;

    expect(got.qrCode).toBeNull();
    expect(got.status).toBe('PENDING'); // what it DID learn still travels
    expect(took).toBeLessThan(3000); // bounded: the rep is waiting
  });

  it('does not ask at all with a zero budget', async () => {
    // How an operator switches the wait off: the push still happens, nothing
    // holds the reply, and the QR lands on the voucher moments later.
    const { svc, asked } = makeSvc({ stored: { jofotaraQrCode: null }, invoiceNumber: 'SI-503' });
    await svc.awaitJofotaraQr('INV-6', 0);
    expect(asked).toEqual([]);
  });

  it('stops short when the sale is not mapped to an ERP invoice yet', async () => {
    // Nothing to ask ABOUT: the push has not produced an invoice number. The
    // poll picks it up once it has one.
    const { svc, asked } = makeSvc({ stored: { jofotaraQrCode: null }, invoiceNumber: null });
    const got = await svc.awaitJofotaraQr('INV-7', 300);
    expect(asked).toEqual([]);
    expect(got.qrCode).toBeNull();
  });

  it('answers "no QR" rather than throwing when the ERP is unreachable', async () => {
    // The sale is already saved. A failure here must read as "not issued yet".
    const { svc, warn } = makeSvc({
      stored: { jofotaraQrCode: null },
      invoiceNumber: 'SI-504',
      erpThrows: true,
    });
    const got = await svc.awaitJofotaraQr('INV-8', 300);
    expect(got).toEqual({ qrCode: null, status: null });
    expect(warn).toHaveBeenCalled();
  });

  it('does not ask while the ERP connection is switched off', async () => {
    const { svc, asked } = makeSvc({
      stored: { jofotaraQrCode: null },
      invoiceNumber: 'SI-505',
      erpOn: false,
    });
    await svc.awaitJofotaraQr('INV-9', 300);
    expect(asked).toEqual([]);
  });
});
