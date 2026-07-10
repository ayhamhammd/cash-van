import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Redesign: accounts live in the ERP. Link each rep to an ERP GL account, and store the
 * three main settlement accounts (sales / cash-collection / cheque-collection) as ERP
 * chart-of-accounts references on app_settings. Drops the short-lived FlowVan-local
 * main_*_account_id columns from the prior iteration.
 * See docs/SPEC-rep-erp-accounts-settlement.md.
 */
export class RepErpAccounts1721401000000 implements MigrationInterface {
  name = 'RepErpAccounts1721401000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── reps: link to the rep's ERP GL account ──────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "reps" ADD COLUMN IF NOT EXISTS "erp_account_id" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "reps" ADD COLUMN IF NOT EXISTS "erp_account_code" text`,
    );

    // ── app_settings: retire prior FlowVan-local destinations ───────────────
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP CONSTRAINT IF EXISTS "fk_app_settings_main_sales_account"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP CONSTRAINT IF EXISTS "fk_app_settings_main_collections_account"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "main_sales_account_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "main_collections_account_id"`,
    );

    // ── app_settings: the three main ERP accounts (id + code snapshot each) ──
    for (const col of [
      'erp_sales_account_id',
      'erp_sales_account_code',
      'erp_cash_collection_account_id',
      'erp_cash_collection_account_code',
      'erp_cheque_collection_account_id',
      'erp_cheque_collection_account_code',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "${col}" text`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const col of [
      'erp_sales_account_id',
      'erp_sales_account_code',
      'erp_cash_collection_account_id',
      'erp_cash_collection_account_code',
      'erp_cheque_collection_account_id',
      'erp_cheque_collection_account_code',
    ]) {
      await queryRunner.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "${col}"`);
    }
    await queryRunner.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "main_sales_account_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "main_collections_account_id" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "reps" DROP COLUMN IF EXISTS "erp_account_code"`);
    await queryRunner.query(`ALTER TABLE "reps" DROP COLUMN IF EXISTS "erp_account_id"`);
  }
}
