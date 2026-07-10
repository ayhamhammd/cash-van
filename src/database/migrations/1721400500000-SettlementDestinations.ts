import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replace the single `main_cash_account_id` with two configurable settlement
 * destinations: a primary SALES account (sales box) and a primary COLLECTIONS
 * account (receipts + cheque boxes). Point both at one account for a single
 * combined destination, or split them. Destinations may be ANY active account
 * defined on the dashboard (not just COMPANY-kind).
 * See docs/SPEC-accounting-page-main-account.md.
 */
export class SettlementDestinations1721400500000 implements MigrationInterface {
  name = 'SettlementDestinations1721400500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "main_sales_account_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "main_collections_account_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings"
         ADD CONSTRAINT "fk_app_settings_main_sales_account"
         FOREIGN KEY ("main_sales_account_id")
         REFERENCES "cash_accounts" ("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings"
         ADD CONSTRAINT "fk_app_settings_main_collections_account"
         FOREIGN KEY ("main_collections_account_id")
         REFERENCES "cash_accounts" ("id") ON DELETE SET NULL`,
    );
    // Carry the old single main account over as the combined default, then drop it.
    await queryRunner.query(
      `UPDATE "app_settings"
          SET "main_sales_account_id" = "main_cash_account_id",
              "main_collections_account_id" = "main_cash_account_id"
        WHERE "main_cash_account_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP CONSTRAINT IF EXISTS "fk_app_settings_main_cash_account"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "main_cash_account_id"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "main_cash_account_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings"
         ADD CONSTRAINT "fk_app_settings_main_cash_account"
         FOREIGN KEY ("main_cash_account_id")
         REFERENCES "cash_accounts" ("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `UPDATE "app_settings" SET "main_cash_account_id" = "main_sales_account_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP CONSTRAINT IF EXISTS "fk_app_settings_main_collections_account"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP CONSTRAINT IF EXISTS "fk_app_settings_main_sales_account"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "main_collections_account_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "main_sales_account_id"`,
    );
  }
}
