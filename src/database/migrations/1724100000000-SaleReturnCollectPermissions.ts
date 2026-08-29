import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Split the coarse "can make voucher" capability into the three field actions an
 * admin actually wants to switch per salesman, plus a gate on collections:
 *
 *   can_create_sale       — may create a SALE voucher
 *   can_create_return     — may create a RETURN voucher
 *   can_make_collection   — may record a collection
 *
 * BACKFILL from can_make_voucher so nobody loses an ability on upgrade: a rep who
 * could make vouchers keeps sale, return and collection; a rep who could not gets
 * none. After this, the three switches are independent — turning off can_create_sale
 * blocks sales while leaving returns and collections alone. ORDER and the other
 * voucher kinds still ride can_make_voucher (the create endpoint's fallback gate).
 */
export class SaleReturnCollectPermissions1724100000000
  implements MigrationInterface
{
  name = 'SaleReturnCollectPermissions1724100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "can_create_sale" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "can_create_return" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "can_make_collection" boolean NOT NULL DEFAULT false`,
    );
    // Preserve current behaviour: mirror the coarse flag onto the three new ones.
    await queryRunner.query(
      `UPDATE "users"
          SET "can_create_sale" = "can_make_voucher",
              "can_create_return" = "can_make_voucher",
              "can_make_collection" = "can_make_voucher"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "can_make_collection"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "can_create_return"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "can_create_sale"`,
    );
  }
}
