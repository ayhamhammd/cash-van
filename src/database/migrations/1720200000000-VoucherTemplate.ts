import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-company voucher (receipt) print template, stored as an override delta on
 * the single-row app_settings table. The resolved template the app renders is
 * BASE_VOUCHER_TEMPLATE merged with these overrides; an empty `{}` means the
 * company inherits the Jordan base unchanged (and benefits from future base
 * changes).
 */
export class VoucherTemplate1720200000000 implements MigrationInterface {
  name = 'VoucherTemplate1720200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_settings"
        ADD COLUMN IF NOT EXISTS "voucher_template_overrides" jsonb NOT NULL DEFAULT '{}'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_settings"
        DROP COLUMN IF EXISTS "voucher_template_overrides"
    `);
  }
}
