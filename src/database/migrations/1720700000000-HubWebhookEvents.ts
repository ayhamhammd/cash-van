import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Inbound Integration Hub webhook events (Hub → Van): idempotency guard +
 * audit log. See docs/SPEC-integration-hub.md Phase 2.
 */
export class HubWebhookEvents1720700000000 implements MigrationInterface {
  name = 'HubWebhookEvents1720700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hub_webhook_events" (
        "id"           uuid NOT NULL DEFAULT uuid_generate_v4(),
        "dedup_key"    text NOT NULL,
        "event_type"   text NOT NULL,
        "external_id"  text,
        "payload"      jsonb,
        "status"       text NOT NULL DEFAULT 'received',
        "error"        text,
        "processed_at" timestamptz,
        "received_at"  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_hub_webhook_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_hub_webhook_dedup" ON "hub_webhook_events" ("dedup_key")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_hub_webhook_status" ON "hub_webhook_events" ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "hub_webhook_events"`);
  }
}
