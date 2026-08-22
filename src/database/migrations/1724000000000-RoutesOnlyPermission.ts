import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Routes only" — a salesman who reaches customers solely through the day's
 * route, with the Customers list hidden on the app home screen.
 *
 * Default FALSE like every other capability on this table, so no salesman is
 * restricted on upgrade. It is a UI/workflow flag, not a permission the API
 * enforces: a route-only rep still opens a customer from a route stop, so there
 * is no endpoint to gate — only the app's home screen reads it.
 */
export class RoutesOnlyPermission1724000000000 implements MigrationInterface {
  name = 'RoutesOnlyPermission1724000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "routes_only" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "routes_only"`);
  }
}
