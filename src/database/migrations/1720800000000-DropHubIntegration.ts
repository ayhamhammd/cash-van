import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop the ERP Integration Hub feature: remove the hub_* config columns from
 * app_settings and the hub_webhook_events table. The Van → ERP push now goes
 * directly to the ERP (the Hub middleware was removed). All statements guard
 * with IF EXISTS so this is idempotent on any DB state.
 */
export class DropHubIntegration1720800000000 implements MigrationInterface {
  name = 'DropHubIntegration1720800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
    await queryRunner.query(`DROP TABLE IF EXISTS "hub_webhook_events"`);
  }

  public async down(): Promise<void> {
    // No-op: the Integration Hub feature has been removed; there is nothing to
    // recreate. (The original HubConfig / HubWebhookEvents migrations remain as
    // historical record if a rebuild from scratch is ever needed.)
  }
}
