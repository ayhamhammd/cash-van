import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F12 — staging inbox for mobile-synced vouchers & collections. The app posts
 * here first; the server assigns the authoritative number and promotes rows
 * into the main tables, leaving failed ones for review.
 */
export class VoucherInbox1718700000000 implements MigrationInterface {
  name = 'VoucherInbox1718700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "voucher_inbox" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "type"            text NOT NULL,
        "client_ref"      text,
        "rep_id"          uuid,
        "user_code"       text,
        "assigned_number" text,
        "payload"         jsonb NOT NULL,
        "status"          text NOT NULL DEFAULT 'pending',
        "result_ref"      text,
        "error"           text,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "processed_at"    timestamptz
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_voucher_inbox_status"
         ON "voucher_inbox" ("status", "created_at" DESC)`,
    );
    // Idempotency: one inbox row per client document (when a ref is supplied).
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_voucher_inbox_client_ref"
         ON "voucher_inbox" ("client_ref") WHERE "client_ref" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "voucher_inbox"`);
  }
}
