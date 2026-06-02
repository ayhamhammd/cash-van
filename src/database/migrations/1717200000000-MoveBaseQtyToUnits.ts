import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Refine the units model per business rule "piece is forever the base unit":
 *   - `base_qty` is a property of the unit itself (carton = 24 pieces is a fact
 *     about *carton*, not about any one item).
 *   - `item_units` keeps only barcode + sale_price per (item, unit) pair.
 *   - A canonical `PCE` row (base_qty = 1) is seeded as the single base unit.
 * Existing per-mapping `base_qty` is consolidated up to the unit master (max
 * factor wins) before the column is dropped; the per-item `is_base` flag is
 * removed entirely.
 */
export class MoveBaseQtyToUnits1717200000000 implements MigrationInterface {
  name = 'MoveBaseQtyToUnits1717200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "units" ADD COLUMN "base_qty" INTEGER NOT NULL DEFAULT 1 CHECK ("base_qty" >= 1)`,
    );

    // Lift the factor out of item_units onto the unit it points at.
    await queryRunner.query(`
      UPDATE "units" u
         SET "base_qty" = sub.bq
        FROM (
          SELECT "unit_id", MAX("base_qty") AS bq
            FROM "item_units"
           GROUP BY "unit_id"
        ) sub
       WHERE u."id" = sub."unit_id"
    `);

    // The per-mapping fields go away.
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_item_units_one_base"`);
    await queryRunner.query(`ALTER TABLE "item_units" DROP COLUMN IF EXISTS "is_base"`);
    await queryRunner.query(`ALTER TABLE "item_units" DROP COLUMN IF EXISTS "base_qty"`);

    // Seed the canonical base unit if it doesn't already exist.
    await queryRunner.query(`
      INSERT INTO "units" ("code", "name_ar", "name_en", "base_qty")
      VALUES ('PCE', 'قطعة', 'piece', 1)
      ON CONFLICT ("code") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the columns (factor + is_base) on item_units. Existing rows get
    // base_qty from their unit; is_base is false everywhere.
    await queryRunner.query(
      `ALTER TABLE "item_units" ADD COLUMN "base_qty" INTEGER NOT NULL DEFAULT 1 CHECK ("base_qty" >= 1)`,
    );
    await queryRunner.query(
      `ALTER TABLE "item_units" ADD COLUMN "is_base" BOOLEAN NOT NULL DEFAULT FALSE`,
    );
    await queryRunner.query(`
      UPDATE "item_units" iu
         SET "base_qty" = u."base_qty"
        FROM "units" u
       WHERE u."id" = iu."unit_id"
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_item_units_one_base" ON "item_units" ("item_id") WHERE "is_base" = TRUE`,
    );
    await queryRunner.query(`ALTER TABLE "units" DROP COLUMN IF EXISTS "base_qty"`);
    // Seeded PCE row is left behind — harmless.
  }
}
