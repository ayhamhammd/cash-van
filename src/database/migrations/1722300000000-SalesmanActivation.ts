import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Salesman seat activation: a new salesman arrives frozen and needs a key to
 * sell.
 *
 * ## Why every default here is "off"
 *
 * Existing clients are already running with salesmen in the field. If this
 * shipped switched on, every one of their reps would be locked out on the next
 * deploy — a licensing feature would read as a total outage.
 *
 * So:
 *   - `salesman_activation_enabled` defaults FALSE. Nothing changes until
 *     someone deliberately turns it on for that installation.
 *   - `reps.is_frozen` defaults FALSE, so every salesman that already exists
 *     stays exactly as they are. Freezing is applied by application code when
 *     a NEW salesman is provisioned and the flag is on — never retroactively.
 *
 * The result is that running this migration on a live client is a no-op they
 * cannot notice, which is the only safe way to ship a lock.
 */
export class SalesmanActivation1722300000000 implements MigrationInterface {
  name = 'SalesmanActivation1722300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "reps"
        ADD COLUMN "is_frozen" boolean NOT NULL DEFAULT false,
        ADD COLUMN "activated_at" timestamptz,
        ADD COLUMN "activated_by" uuid
    `);

    // Frozen reps are the ones the dashboard needs to surface; on a healthy
    // installation that is a handful of rows out of the whole table.
    await queryRunner.query(`
      CREATE INDEX "idx_reps_is_frozen" ON "reps" ("is_frozen") WHERE "is_frozen" = true
    `);

    await queryRunner.query(`
      ALTER TABLE "app_settings"
        ADD COLUMN "salesman_activation_enabled" boolean NOT NULL DEFAULT false
    `);

    // Belt and braces: the column default already covers existing rows, but an
    // explicit UPDATE documents the intent and survives a future default change.
    await queryRunner.query(
      `UPDATE "reps" SET "is_frozen" = false WHERE "is_frozen" IS DISTINCT FROM false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "salesman_activation_enabled"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_reps_is_frozen"`);
    await queryRunner.query(`
      ALTER TABLE "reps"
        DROP COLUMN IF EXISTS "activated_by",
        DROP COLUMN IF EXISTS "activated_at",
        DROP COLUMN IF EXISTS "is_frozen"
    `);
  }
}
