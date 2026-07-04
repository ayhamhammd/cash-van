import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FastReport-style banded voucher layout ("Voucher Designer") stored whole on
 * the single-row app_settings table. NULL means the company inherits
 * DEFAULT_VOUCHER_REPORT (the Jordan 80 mm thermal layout).
 */
export class VoucherReport1720300000000 implements MigrationInterface {
  name = 'VoucherReport1720300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_settings"
        ADD COLUMN IF NOT EXISTS "voucher_report" jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_settings"
        DROP COLUMN IF EXISTS "voucher_report"
    `);
  }
}
