import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Device binding: one live handset per salesman, one salesman per handset.
 *
 * The two partial unique indexes are the rule itself, not an optimisation —
 * they hold even if a race slips past the service checks, which is exactly the
 * case a second login attempt from a second phone creates. They cover only live
 * rows so a released device can be re-bound, and its history stays behind.
 */
export class UserDevices1723600000000 implements MigrationInterface {
  name = 'UserDevices1723600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_devices" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "updated_at"    timestamptz NOT NULL DEFAULT now(),
        "deleted_at"    timestamptz,
        "version"       integer NOT NULL DEFAULT 1,
        "user_id"       uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "device_id"     text NOT NULL,
        "platform"      text,
        "model"         text,
        "bound_at"      timestamptz NOT NULL DEFAULT now(),
        "last_seen_at"  timestamptz,
        "released_at"   timestamptz,
        "released_by"   uuid,
        "session_jti"   text,
        "tracking_jti"  text
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_user_devices_user" ON "user_devices" ("user_id")`,
    );
    // One live binding per handset — blocks a second user signing in here.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_user_devices_device_live"
         ON "user_devices" ("device_id") WHERE "released_at" IS NULL`,
    );
    // One live binding per user — blocks the same user signing in elsewhere.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_user_devices_user_live"
         ON "user_devices" ("user_id") WHERE "released_at" IS NULL`,
    );
    // Tracking tokens are checked against this on every location upload.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_user_devices_tracking_jti"
         ON "user_devices" ("tracking_jti") WHERE "released_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "user_devices"`);
  }
}
