import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * JoFotara e-invoice QR + status cached onto the voucher.
 *
 * The QR is produced by the government only after the ERP submits the invoice,
 * so it lands asynchronously: the outbox reconciler polls the ERP by invoice
 * number and fills these in once the document is validated. The dashboard and
 * the mobile receipt read them from here.
 */
export class VoucherJofotaraQr1725600000000 implements MigrationInterface {
  name = 'VoucherJofotaraQr1725600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "voucher_headers" ADD COLUMN IF NOT EXISTS "jofotara_qr_code" text`);
    await q.query(`ALTER TABLE "voucher_headers" ADD COLUMN IF NOT EXISTS "jofotara_status" text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "voucher_headers" DROP COLUMN IF EXISTS "jofotara_status"`);
    await q.query(`ALTER TABLE "voucher_headers" DROP COLUMN IF EXISTS "jofotara_qr_code"`);
  }
}
