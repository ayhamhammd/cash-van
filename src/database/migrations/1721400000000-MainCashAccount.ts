import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Designate a single company cash account as THE "main account" that EOD settlements
 * sweep every rep box into. Stored as a pointer on the single app_settings row.
 * See docs/SPEC-accounting-page-main-account.md.
 */
export class MainCashAccount1721400000000 implements MigrationInterface {
  name = 'MainCashAccount1721400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "main_cash_account_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings"
         ADD CONSTRAINT "fk_app_settings_main_cash_account"
         FOREIGN KEY ("main_cash_account_id")
         REFERENCES "cash_accounts" ("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP CONSTRAINT IF EXISTS "fk_app_settings_main_cash_account"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "main_cash_account_id"`,
    );
  }
}
