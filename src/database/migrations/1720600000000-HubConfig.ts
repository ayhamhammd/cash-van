import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ERP Integration Hub connection config on app_settings (Phase 0 of
 * docs/SPEC-integration-hub.md). Secrets are AES-256-GCM encrypted (same pattern
 * as the ERP + AI keys); a masked last4 is stored for display.
 */
export class HubConfig1720600000000 implements MigrationInterface {
  name = 'HubConfig1720600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_settings"
        ADD COLUMN IF NOT EXISTS "hub_enabled"                  boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "hub_base_url"                 text,
        ADD COLUMN IF NOT EXISTS "hub_partner_id"               text,
        ADD COLUMN IF NOT EXISTS "hub_sync_secret_encrypted"    text,
        ADD COLUMN IF NOT EXISTS "hub_sync_secret_last4"        text,
        ADD COLUMN IF NOT EXISTS "hub_webhook_secret_encrypted" text,
        ADD COLUMN IF NOT EXISTS "hub_webhook_secret_last4"     text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_settings"
        DROP COLUMN IF EXISTS "hub_enabled",
        DROP COLUMN IF EXISTS "hub_base_url",
        DROP COLUMN IF EXISTS "hub_partner_id",
        DROP COLUMN IF EXISTS "hub_sync_secret_encrypted",
        DROP COLUMN IF EXISTS "hub_sync_secret_last4",
        DROP COLUMN IF EXISTS "hub_webhook_secret_encrypted",
        DROP COLUMN IF EXISTS "hub_webhook_secret_last4"
    `);
  }
}
