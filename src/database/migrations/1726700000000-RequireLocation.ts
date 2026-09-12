import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-rep requirement: the salesman app refuses to sign in, and refuses to write
 * any document, unless the device grants location. Off by default — every other
 * capability here is opt-in, and switching it on for everyone would lock out any
 * rep who has the permission denied at the moment of the upgrade.
 */
export class RequireLocation1726700000000 implements MigrationInterface {
  name = 'RequireLocation1726700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "require_location" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "require_location"`);
  }
}
