import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Optional administrator approval for web sign-ins from untrusted browsers.
 * Off by default (app_settings.require_device_approval), so upgrading changes
 * nothing until an administrator turns it on.
 */
export class LoginApprovals1728200000000 implements MigrationInterface {
  name = 'LoginApprovals1728200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS require_device_approval boolean NOT NULL DEFAULT false`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS trusted_devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        device_hash text NOT NULL,
        label text NULL,
        last_ip text NULL,
        trusted_by uuid NULL,
        last_seen_at timestamptz NULL,
        revoked_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL,
        version integer NOT NULL DEFAULT 1
      )`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_trusted_devices_user_id" ON trusted_devices (user_id)`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_trusted_devices_user_device_live
        ON trusted_devices (user_id, device_hash) WHERE revoked_at IS NULL`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS login_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        device_hash text NOT NULL,
        label text NULL,
        user_agent text NULL,
        ip text NULL,
        status text NOT NULL DEFAULT 'pending',
        trust boolean NOT NULL DEFAULT false,
        decided_by uuid NULL,
        decided_at timestamptz NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_login_requests_user_id" ON login_requests (user_id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_login_requests_status ON login_requests (status, created_at)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS login_requests`);
    await q.query(`DROP TABLE IF EXISTS trusted_devices`);
    await q.query(`ALTER TABLE app_settings DROP COLUMN IF EXISTS require_device_approval`);
  }
}
