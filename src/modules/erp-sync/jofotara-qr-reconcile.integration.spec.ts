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
    for (let i = 0; i < 45; i++) await sale(`${P}-S-${i}`, i, `SI-${1000 + i}`);
    erpInvoices = [{ invoiceNumber: 'SI-1044', jofotaraStatus: 'SUBMITTED', jofotaraQrCode: 'QR-OLDEST' }];
    const svc = makeService();

    await svc.reconcileJofotaraQr(); // newest 20
    await svc.reconcileJofotaraQr(); // next 20
    expect((await qrOf(`${P}-S-44`)).jofotara_qr_code).toBeNull();
    await svc.reconcileJofotaraQr(); // the last 5 — the oldest is reached
    expect((await qrOf(`${P}-S-44`)).jofotara_qr_code).toBe('QR-OLDEST');
    expect(new Set(asked).size).toBe(45); // every invoice asked once, none twice
  });

  it('leaves a rejected invoice alone', async () => {
    await sale(`${P}-INV-9`, 5, 'SI-9');
    await q(`UPDATE voucher_headers SET jofotara_status = 'REJECTED' WHERE voucher_number = $1`, [`${P}-INV-9`]);
    await makeService().reconcileJofotaraQr();
    expect(asked).toEqual([]);
  });
});
