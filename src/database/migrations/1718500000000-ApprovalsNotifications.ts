import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F10 — approval requests (salesman → manager) and the per-user notification
 * inbox every feature publishes into.
 */
export class ApprovalsNotifications1718500000000 implements MigrationInterface {
  name = 'ApprovalsNotifications1718500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "approval_requests" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "type"            text NOT NULL,
        "status"          text NOT NULL DEFAULT 'pending',
        "requester_user"  uuid NOT NULL,
        "rep_id"          uuid,
        "customer_number" text,
        "payload"         jsonb NOT NULL,
        "note"            text,
        "reviewer_user"   uuid,
        "decision_note"   text,
        "result_voucher"  text,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "decided_at"      timestamptz
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_approval_requests_status"
         ON "approval_requests" ("status", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_approval_requests_requester"
         ON "approval_requests" ("requester_user", "created_at" DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notifications" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"    uuid NOT NULL,
        "kind"       text NOT NULL,
        "title_ar"   text NOT NULL,
        "title_en"   text NOT NULL,
        "body_ar"    text,
        "body_en"    text,
        "ref_type"   text,
        "ref_id"     text,
        "read_at"    timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_notifications_user"
         ON "notifications" ("user_id", "read_at", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notifications"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "approval_requests"`);
  }
}
