import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-user permissions for van stock requests.
 *
 * Two, because they are two different jobs. Raising a request is something a
 * salesman does from a van; deciding one is warehouse work. The person who
 * decides is not always an office admin, which is why this is a user flag and
 * not another role.
 *
 * Both default FALSE, like every other capability on this table. Existing
 * admins are unaffected — the admin role passes every gate regardless.
 */
export class StockRequestPermissions1723400000000 implements MigrationInterface {
  name = 'StockRequestPermissions1723400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "can_request_stock" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "can_approve_stock_request" boolean NOT NULL DEFAULT false`,
    );

    // Grant it to salesmen who already have a van, so a working deployment does
    // not go quiet on upgrade: every rep who could request stock yesterday can
    // still request it today. New users start with nothing, as they should.
    await queryRunner.query(`
      UPDATE "users" SET "can_request_stock" = true
      WHERE "id" IN (SELECT "user_id" FROM "reps" WHERE "user_id" IS NOT NULL AND "van_id" IS NOT NULL)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "can_approve_stock_request"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "can_request_stock"`);
  }
}
