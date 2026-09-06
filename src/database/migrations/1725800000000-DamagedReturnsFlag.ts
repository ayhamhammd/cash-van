import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Program-feature flag: track DAMAGED/EXPIRED returns as a separate inventory.
 *
 * OFF by default — returns behave exactly as before until an admin activates the
 * feature from the Program Features settings screen. See
 * docs/SPEC-damaged-expired-returns.md.
 */
export class DamagedReturnsFlag1725800000000 implements MigrationInterface {
  name = 'DamagedReturnsFlag1725800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "damaged_returns_enabled" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "damaged_returns_enabled"`);
  }
}
