import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The ERP's "الإرسال التلقائي إلى جوفوترة" switch, mirrored from GET /organization.
 *
 * The van app waits up to 8 seconds before printing a sale for its JoFotara QR.
 * With the switch off the ERP never files the invoice, no QR ever comes, and
 * every sale was printed 8 seconds late for nothing.
 *
 * NULL until the first organization pull after this lands, and on an ERP too old
 * to send it. NULL means "not known", and the app keeps waiting — a missing QR on
 * a filed invoice is worse than a slow print.
 */
export class JofotaraAutoSubmit1728560000000 implements MigrationInterface {
  name = 'JofotaraAutoSubmit1728560000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS jofotara_auto_submit boolean NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE app_settings DROP COLUMN IF EXISTS jofotara_auto_submit`);
  }
}
