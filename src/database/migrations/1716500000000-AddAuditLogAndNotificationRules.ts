import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plan 09 — System: Audit Log + Notification Rules.
 *
 *  - `audit_log`: who-changed-what, range-partitioned monthly by `acted_at`
 *    (PK includes the partition key). Written by the global AuditInterceptor.
 *  - `notification_rules`: configurable alert rules (trigger → channel).
 *
 * Single-tenant — no tenant_id / RLS.
 */
export class AddAuditLogAndNotificationRules1716500000000 implements MigrationInterface {
  name = 'AddAuditLogAndNotificationRules1716500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "audit_log" (
        "id"         BIGSERIAL,
        "actor_id"   UUID REFERENCES "users"("id") ON DELETE SET NULL,
        "entity"     TEXT NOT NULL,
        "entity_id"  TEXT NOT NULL,
        "action"     TEXT NOT NULL,
        "diff_json"  JSONB,
        "ip_address" INET,
        "user_agent" TEXT,
        "acted_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("id", "acted_at")
      ) PARTITION BY RANGE ("acted_at")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_audit_entity" ON "audit_log" ("entity", "entity_id", "acted_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_audit_actor" ON "audit_log" ("actor_id", "acted_at" DESC)
    `);

    const now = new Date();
    const cur = monthRange(now);
    const nxt = monthRange(addMonths(now, 1));
    await queryRunner.query(`
      CREATE TABLE "${cur.tableName}" PARTITION OF "audit_log"
        FOR VALUES FROM ('${cur.from}') TO ('${cur.to}')
    `);
    await queryRunner.query(`
      CREATE TABLE "${nxt.tableName}" PARTITION OF "audit_log"
        FOR VALUES FROM ('${nxt.from}') TO ('${nxt.to}')
    `);
    await queryRunner.query(`
      CREATE TABLE "audit_log_default" PARTITION OF "audit_log" DEFAULT
    `);

    await queryRunner.query(`
      CREATE TABLE "notification_rules" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"       TEXT NOT NULL,
        "trigger"    TEXT NOT NULL,
        "threshold"  JSONB,
        "channel"    TEXT NOT NULL,
        "recipients" UUID[] NOT NULL DEFAULT '{}',
        "is_active"  BOOLEAN NOT NULL DEFAULT TRUE,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "ck_notif_trigger"
          CHECK ("trigger" IN ('anomaly_high','churn_spike','rep_offline','overdue')),
        CONSTRAINT "ck_notif_channel"
          CHECK ("channel" IN ('email','sms','whatsapp','push'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notif_active_trigger" ON "notification_rules" ("is_active", "trigger")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_rules"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_log" CASCADE`);
  }
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function monthRange(d: Date): { tableName: string; from: string; to: string } {
  const year = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const next = addMonths(d, 1);
  return {
    tableName: `audit_log_${year}${mm}`,
    from: `${year}-${mm}-01`,
    to: `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`,
  };
}
