/**
 * JoFotara QR mirroring, against a real database.
 *
 * The case from the field: an invoice the ERP had exported to JoFotara still read
 * "pending" on the dashboard, because the QR never came across. The poll took the
 * twenty newest QR-less sales and skipped the unmapped ones inside the loop — so
 * newer sales that can never get a QR (ERP movement mirrors, unpushed sales) held
 * every slot, and the real invoice below them was never asked about. And the ERP
 * matches `number` as a substring, so the old fallback to the first row could copy
 * a different invoice's QR onto the voucher.
 *
 * Skipped unless DB_NAME points at a database with the schema applied.
 */
import { DataSource } from 'typeorm';

import { ErpOutboxService } from './erp-outbox.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;
const P = 'ZZQR';
const USER_CODE = `${P}-U`;

run('JoFotara QR reconcile (real DB)', () => {
  let ds: DataSource;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** What the stubbed ERP answers for GET sales-invoices?number= — substring match, like the real one. */
  let erpInvoices: Array<{ invoiceNumber: string; jofotaraStatus: string | null; jofotaraQrCode: string | null }> = [];
  const asked: string[] = [];

  function makeService(): ErpOutboxService {
    const svc = Object.create(ErpOutboxService.prototype) as Record<string, unknown>;
    svc.settings = { getErpConfig: async () => ({ enabled: true, baseUrl: 'http://stub', apiKey: 'k' }) };
    svc.erp = {
      list: async (_path: string, params: { number: string }) => {
        asked.push(params.number);
        return { data: erpInvoices.filter((i) => i.invoiceNumber.includes(params.number)) };
      },
    };
    svc.headers = ds.getRepository('VoucherHeader');
    svc.logger = { log: () => undefined, warn: () => undefined };
    svc.reconcilingQr = false;
    svc.qrOffset = 0;
    return svc as unknown as ErpOutboxService;
  }

  async function sale(voucher: string, minutesAgo: number, invoice?: string) {
    await q(
      `INSERT INTO voucher_headers (voucher_number, trans_kind, user_code, in_date, is_posted)
       VALUES ($1, 'SALE', $2, now() - ($3 || ' minutes')::interval, TRUE)`,
      [voucher, USER_CODE, String(minutesAgo)],
    );
    if (invoice) {
      await q(
        `INSERT INTO erp_id_map (entity, erp_id, erp_code, local_id) VALUES ('voucher', $1, $2, $1)`,
        [voucher, invoice],
      );
    }
  }

  const qrOf = async (voucher: string) =>
    (await q(`SELECT jofotara_qr_code, jofotara_status FROM voucher_headers WHERE voucher_number = $1`, [voucher]))[0];

  async function purge() {
    await q(`DELETE FROM erp_id_map WHERE erp_id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM voucher_headers WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'cashvan',
      database: process.env.DB_NAME as string,
      entities: [__dirname + '/../../**/*.entity.{ts,js}'],
      synchronize: false,
    });
    await ds.initialize();
    await q(`INSERT INTO transaction_kinds (trans_kind, trans_name, sign) VALUES ('SALE','بيع',-1) ON CONFLICT DO NOTHING`);
  }, 120_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  beforeEach(async () => {
    await purge();
    erpInvoices = [];
    asked.length = 0;
    await q(
      `INSERT INTO users (user_number, name, password_hash, user_type) VALUES ($1,$1,'x','SALES') ON CONFLICT DO NOTHING`,
      [USER_CODE],
    );
  });

  it('reaches an exported invoice below sales that can never get a QR', async () => {
    // 25 newer sales with no ERP invoice — mirrors, unpushed — ahead of the real one.
    for (let i = 0; i < 25; i++) await sale(`${P}-ERP-MV-${i}`, i);
    await sale(`${P}-INV-126`, 600, 'SI-2026-000126');
    erpInvoices = [{ invoiceNumber: 'SI-2026-000126', jofotaraStatus: 'SUBMITTED', jofotaraQrCode: 'QR-126' }];

    await makeService().reconcileJofotaraQr();

    expect(await qrOf(`${P}-INV-126`)).toEqual({ jofotara_qr_code: 'QR-126', jofotara_status: 'SUBMITTED' });
    expect(asked).toEqual(['SI-2026-000126']); // the mirrors cost no ERP call at all
  });

  it("never copies another invoice's QR when the number is only a substring match", async () => {
    await sale(`${P}-INV-12`, 5, 'SI-12');
    // The ERP's substring match returns SI-120 for "SI-12"; SI-12 itself has no QR yet.
    erpInvoices = [
      { invoiceNumber: 'SI-120', jofotaraStatus: 'SUBMITTED', jofotaraQrCode: 'QR-OF-SI-120' },
      { invoiceNumber: 'SI-12', jofotaraStatus: 'PENDING', jofotaraQrCode: null },
    ];

    await makeService().reconcileJofotaraQr();

    expect(await qrOf(`${P}-INV-12`)).toEqual({ jofotara_qr_code: null, jofotara_status: 'PENDING' });
  });

  it('rotates through a long backlog instead of re-reading the same page', async () => {
    // 45 mapped sales still waiting; the ERP has a QR only for the OLDEST.
    // Sales 0-14 minutes old are inside the fresh window; 15-44 are the backlog.
    for (let i = 0; i < 45; i++) await sale(`${P}-S-${i}`, i, `SI-${1000 + i}`);
    erpInvoices = [{ invoiceNumber: 'SI-1044', jofotaraStatus: 'SUBMITTED', jofotaraQrCode: 'QR-OLDEST' }];
    const svc = makeService();

    await svc.reconcileJofotaraQr(); // 10 fresh + backlog 15-24
    await svc.reconcileJofotaraQr(); // 10 fresh + backlog 25-34
    expect((await qrOf(`${P}-S-44`)).jofotara_qr_code).toBeNull();
    await svc.reconcileJofotaraQr(); // 10 fresh + backlog 35-44 — the oldest is reached
    expect((await qrOf(`${P}-S-44`)).jofotara_qr_code).toBe('QR-OLDEST');

    // The backlog is what must not repeat: each of the thirty older invoices is
    // asked exactly once across the three ticks.
    const backlog = asked.filter((n) => Number(n.slice(3)) >= 1015);
    expect(backlog).toHaveLength(30);
    expect(new Set(backlog).size).toBe(30);

    // Fresh sales, by contrast, ARE asked again every tick, and that is the
    // point: a rep is waiting on one of those, so it gets a question per tick
    // until the QR arrives rather than a turn in a queue.
    const fresh = asked.filter((n) => Number(n.slice(3)) < 1010);
    expect(fresh.length).toBeGreaterThan(new Set(fresh).size);
  });

  it('asks about a sale at the counter on the FIRST tick, however long the backlog', async () => {
    // The reported bug: with a few hundred QR-less sales the rotation reached a
    // brand-new sale only after ceil(N/20) ticks — minutes — so the rep had
    // printed and driven off long before the QR landed. The sale a rep is
    // standing and waiting for must never be behind the backlog.
    for (let i = 0; i < 40; i++) await sale(`${P}-OLD-${i}`, 120 + i, `SI-${2000 + i}`);
    await sale(`${P}-NOW`, 0, 'SI-FRESH');
    erpInvoices = [{ invoiceNumber: 'SI-FRESH', jofotaraStatus: 'SUBMITTED', jofotaraQrCode: 'QR-NOW' }];

    await makeService().reconcileJofotaraQr(); // ONE tick

    expect(await qrOf(`${P}-NOW`)).toEqual({
      jofotara_qr_code: 'QR-NOW',
      jofotara_status: 'SUBMITTED',
    });
  });

  it('keeps the backlog moving even when the fresh window is full', async () => {
    // The trap in fixing the above: a company with auto-submit off accumulates
    // QR-less sales that sit in the fresh window until they age out of it. Let
    // the fresh pass take the whole budget and those stall the backlog forever —
    // the same starvation, pointing the other way. Hence the half-budget cap.
    for (let i = 0; i < 30; i++) await sale(`${P}-NEW-${i}`, 0, `SI-${3000 + i}`);
    await sale(`${P}-STUCK`, 900, 'SI-WAITING');
    erpInvoices = [{ invoiceNumber: 'SI-WAITING', jofotaraStatus: 'SUBMITTED', jofotaraQrCode: 'QR-WAITED' }];

    await makeService().reconcileJofotaraQr();

    expect((await qrOf(`${P}-STUCK`)).jofotara_qr_code).toBe('QR-WAITED');
  });

  describe('the QR taken straight from the push reply', () => {
    // The unit spec pins the statement's shape; this pins what Postgres actually
    // does with it, because the whole value of capturing at push time rests on
    // these two behaviours being right.
    type Capture = {
      captureJofotaraFromReply(voucher: string, data: unknown): Promise<void>;
    };

    it('fills in a QR the voucher does not have yet', async () => {
      await sale(`${P}-PUSH-1`, 0, 'SI-PUSH-1');
      await (makeService() as unknown as Capture).captureJofotaraFromReply(`${P}-PUSH-1`, {
        data: { jofotaraQrCode: 'QR-FROM-PUSH', jofotaraStatus: 'SUBMITTED' },
      });
      expect(await qrOf(`${P}-PUSH-1`)).toEqual({
        jofotara_qr_code: 'QR-FROM-PUSH',
        jofotara_status: 'SUBMITTED',
      });
      expect(asked).toEqual([]); // and it cost no ERP call at all
    });

    it('does not overwrite a QR already on the voucher', async () => {
      await sale(`${P}-PUSH-2`, 0, 'SI-PUSH-2');
      await q(
        `UPDATE voucher_headers SET jofotara_qr_code = 'QR-ALREADY', jofotara_status = 'SUBMITTED'
          WHERE voucher_number = $1`,
        [`${P}-PUSH-2`],
      );

      // A replayed push, carrying a different QR. The stored one wins; the
      // status, being present, is still refreshed.
      await (makeService() as unknown as Capture).captureJofotaraFromReply(`${P}-PUSH-2`, {
        data: { jofotaraQrCode: 'QR-REPLAYED', jofotaraStatus: 'VALIDATED' },
      });

      expect(await qrOf(`${P}-PUSH-2`)).toEqual({
        jofotara_qr_code: 'QR-ALREADY',
        jofotara_status: 'VALIDATED',
      });
    });

    it('leaves a stored status alone when the reply does not mention one', async () => {
      await sale(`${P}-PUSH-3`, 0, 'SI-PUSH-3');
      await q(`UPDATE voucher_headers SET jofotara_status = 'SUBMITTED' WHERE voucher_number = $1`, [
        `${P}-PUSH-3`,
      ]);
      await (makeService() as unknown as Capture).captureJofotaraFromReply(`${P}-PUSH-3`, {
        data: { jofotaraQrCode: 'QR-3' },
      });
      expect(await qrOf(`${P}-PUSH-3`)).toEqual({
        jofotara_qr_code: 'QR-3',
        jofotara_status: 'SUBMITTED',
      });
    });

    it('takes the voucher out of the poll’s candidate set', async () => {
      // The point of the whole exercise: a sale whose QR arrived with the push
      // must not then be asked about on every reconcile tick.
      await sale(`${P}-PUSH-4`, 0, 'SI-PUSH-4');
      const svc = makeService();
      await (svc as unknown as Capture).captureJofotaraFromReply(`${P}-PUSH-4`, {
        data: { jofotaraQrCode: 'QR-4' },
      });

      await svc.reconcileJofotaraQr();

      expect(asked).not.toContain('SI-PUSH-4');
    });
  });

  it('leaves a rejected invoice alone', async () => {
    await sale(`${P}-INV-9`, 5, 'SI-9');
    await q(`UPDATE voucher_headers SET jofotara_status = 'REJECTED' WHERE voucher_number = $1`, [`${P}-INV-9`]);
    await makeService().reconcileJofotaraQr();
    expect(asked).toEqual([]);
  });
});
