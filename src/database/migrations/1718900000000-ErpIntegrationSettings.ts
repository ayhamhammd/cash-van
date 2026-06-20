import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ERP (erp-saas) integration settings on the single-row app_settings table:
 * the on/off toggle plus the connection (base URL + encrypted API key) and the
 * last successful sync timestamp.
 */
export class ErpIntegrationSettings1718900000000 implements MigrationInterface {
  name = 'ErpIntegrationSettings1718900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_settings"
        ADD COLUMN IF NOT EXISTS "erp_sync_enabled" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "erp_base_url" text,
        ADD COLUMN IF NOT EXISTS "erp_api_key_encrypted" text,
        ADD COLUMN IF NOT EXISTS "erp_api_key_last4" text,
        ADD COLUMN IF NOT EXISTS "erp_last_sync_at" timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_settings"
        DROP COLUMN IF EXISTS "erp_last_sync_at",
        DROP COLUMN IF EXISTS "erp_api_key_last4",
        DROP COLUMN IF EXISTS "erp_api_key_encrypted",
        DROP COLUMN IF EXISTS "erp_base_url",
        DROP COLUMN IF EXISTS "erp_sync_enabled"
    `);
  }
}
