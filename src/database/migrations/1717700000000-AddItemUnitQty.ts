import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-item conversion factor on item_units. Previously the qty (pieces per
 * unit) was read from the unit master (unit.base_qty); now each item can set
 * its own qty for a unit. Existing rows are backfilled from the unit master so
 * behaviour is unchanged until edited.
 */
export class AddItemUnitQty1717700000000 implements MigrationInterface {
  name = 'AddItemUnitQty1717700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "item_units" ADD COLUMN IF NOT EXISTS "qty" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `UPDATE "item_units" iu SET "qty" = u."base_qty"
         FROM "units" u WHERE u."id" = iu."unit_id"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "item_units" DROP COLUMN IF EXISTS "qty"`,
    );
  }
}
