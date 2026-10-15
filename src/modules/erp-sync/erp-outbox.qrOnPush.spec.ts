import { ErpOutboxService } from './erp-outbox.service';

/**
 * Keeping the JoFotara QR the ERP hands back when it accepts the invoice.
 *
 * The ERP files the invoice with the government as part of accepting it (its
 * auto-submit switch, mirrored here as `app_settings.jofotara_auto_submit`), so
 * the create reply can already name the QR. `pushOne` used to extract only the
 * invoice number and the journal info from that reply and drop the rest — and
 * then `reconcileJofotaraQr` spent the next tick, or the next several, polling
 * the ERP for a value it had already been given. On a busy database that poll
 * is where the reported minutes went.
 *
 * Reading it at push time is what makes the van app's 8-second wait winnable.
 */
type Captured = { sql: string; params: unknown[] };

interface Svc {
  captureJofotaraFromReply(voucherNumber: string, data: unknown): Promise<void>;
  extractJofotara(data: unknown): { qrCode: string | null; status: string | null };
}

function makeSvc(opts: { queryThrows?: boolean } = {}) {
  const queries: Captured[] = [];
  const args: unknown[] = new Array(17).fill(null);
  args[5] = {
    manager: {
      query: async (sql: string, params: unknown[] = []) => {
        if (opts.queryThrows) throw new Error('deadlock detected');
        queries.push({ sql, params });
        return [];
      },
    },
  };
  const svc = new (ErpOutboxService as unknown as new (...a: unknown[]) => unknown)(
    ...args,
  ) as Record<string, unknown>;
  svc.logger = { warn: jest.fn(), log: jest.fn(), debug: jest.fn() };
  return {
    svc: svc as unknown as Svc,
    queries,
    warn: (svc.logger as { warn: jest.Mock }).warn,
  };
}

describe('the QR in the ERP’s reply', () => {
  it('is read from the nested data envelope the ERP normally sends', async () => {
    const { svc, queries } = makeSvc();
    await svc.captureJofotaraFromReply('INV-1', {
      data: { jofotaraQrCode: 'QR-1', jofotaraStatus: 'SUBMITTED' },
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].params).toEqual(['INV-1', 'QR-1', 'SUBMITTED']);
  });

  it('is read from a flat reply too', async () => {
    // Belt and braces: the ERP's write endpoints are not perfectly uniform about
    // the envelope, and a QR missed because of a wrapper is a QR polled for.
    const { svc, queries } = makeSvc();
    await svc.captureJofotaraFromReply('INV-2', {
      jofotaraQrCode: 'QR-2',
      jofotaraStatus: 'SUBMITTED',
    });
    expect(queries[0].params).toEqual(['INV-2', 'QR-2', 'SUBMITTED']);
  });

  it('only ever fills a QR in, never replaces one', async () => {
    // A replayed push must not overwrite a QR the poll may since have corrected,
    // while a status that IS present is the newer fact. The COALESCEs say so.
    const { svc, queries } = makeSvc();
    await svc.captureJofotaraFromReply('INV-3', { data: { jofotaraQrCode: 'QR-3' } });
    expect(queries[0].sql).toMatch(/jofotara_qr_code\s*=\s*COALESCE\(jofotara_qr_code,\s*\$2\)/);
    expect(queries[0].sql).toMatch(/jofotara_status\s*=\s*COALESCE\(\$3,\s*jofotara_status\)/);
  });

  it('writes nothing at all when the reply carries neither', async () => {
    // The common case on an ERP that files asynchronously. It must cost no
    // statement, so the poll remains the only path and nothing is disturbed.
    const { svc, queries } = makeSvc();
    await svc.captureJofotaraFromReply('INV-4', { data: { id: 'x', journalId: 'j1' } });
    await svc.captureJofotaraFromReply('INV-4', null);
    await svc.captureJofotaraFromReply('INV-4', 'not an object');
    expect(queries).toEqual([]);
  });

  it('treats a blank QR as absent rather than writing one', async () => {
    const { svc, queries } = makeSvc();
    await svc.captureJofotaraFromReply('INV-5', {
      data: { jofotaraQrCode: '   ', jofotaraStatus: '' },
    });
    expect(queries).toEqual([]);
  });

  it('records a status with no QR yet, so the dashboard can say PENDING', async () => {
    const { svc, queries } = makeSvc();
    await svc.captureJofotaraFromReply('INV-6', { data: { jofotaraStatus: 'PENDING' } });
    expect(queries[0].params).toEqual(['INV-6', null, 'PENDING']);
  });

  it('never fails the sale over a QR it could not record', async () => {
    // The sale has already posted at this point. Losing the QR costs a poll;
    // throwing here would unwind a document the ERP has accepted.
    const { svc, warn } = makeSvc({ queryThrows: true });
    await expect(
      svc.captureJofotaraFromReply('INV-7', { data: { jofotaraQrCode: 'QR-7' } }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
