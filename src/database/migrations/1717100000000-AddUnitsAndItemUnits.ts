import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Normalize the unit conversions:
 *   - `units`      — global catalog of unit labels (piece, carton, pallet…).
 *   - `item_units` — per-item mapping with the conversion factor + per-unit
 *                    barcode + per-unit sale_price. At most one row per item
 *                    is the base unit (`is_base = true`, `base_qty = 1`).
 * Replaces the legacy `item_switch` (conflated catalog+mapping). Existing rows
 * are migrated; the smallest-factor row per item becomes is_base.
 */
export class AddUnitsAndItemUnits1717100000000 implements MigrationInterface {
  name = 'AddUnitsAndItemUnits1717100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. New tables
    await queryRunner.query(`
      CREATE TABLE "units" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code"       TEXT NOT NULL UNIQUE,
        "name_ar"    TEXT NOT NULL,
        "name_en"    TEXT,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "item_units" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "item_id"    UUID NOT NULL REFERENCES "item_cart"("id") ON DELETE CASCADE,
        "unit_id"    UUID NOT NULL REFERENCES "units"("id") ON DELETE RESTRICT,
        "base_qty"   INTEGER NOT NULL DEFAULT 1 CHECK ("base_qty" >= 1),
        "barcode"    TEXT NOT NULL UNIQUE,
        "sale_price" NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK ("sale_price" >= 0),
        "is_base"    BOOLEAN NOT NULL DEFAULT FALSE,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "uq_item_units_item_unit" UNIQUE ("item_id", "unit_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_item_units_item" ON "item_units" ("item_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_item_units_one_base" ON "item_units" ("item_id") WHERE "is_base" = TRUE`,
    );

    // 2. Backfill `units` from distinct item_switch.unit_name values.
    //    Codes are synthetic (U001, U002…); admin can rename later.
    await queryRunner.query(`
      INSERT INTO "units" ("code", "name_ar")
      SELECT
        'U' || lpad((row_number() OVER (ORDER BY n.unit_name))::text, 3, '0') AS code,
        n.unit_name AS name_ar
      FROM (SELECT DISTINCT "unit_name" FROM "item_switch") n
    `);

    // 3. Backfill `item_units` from item_switch.
    await queryRunner.query(`
      INSERT INTO "item_units" ("item_id", "unit_id", "base_qty", "barcode", "sale_price", "is_base")
      SELECT
        ic."id",
        u."id",
        sw."unit_qty",
        sw."barcode",
        sw."sale_price",
        (sw."unit_qty" = 1) AS is_base
      FROM "item_switch" sw
      JOIN "item_cart" ic ON ic."item_number" = sw."item_number"
      JOIN "units" u      ON u."name_ar" = sw."unit_name"
    `);

    // 4. For items that ended up with no is_base row (no factor-1 switch),
    //    promote the smallest-factor row to base.
    await queryRunner.query(`
      WITH need_base AS (
        SELECT iu.item_id
        FROM "item_units" iu
        GROUP BY iu.item_id
        HAVING SUM(CASE WHEN iu.is_base THEN 1 ELSE 0 END) = 0
      ),
      pick AS (
        SELECT DISTINCT ON (iu.item_id) iu.id
        FROM "item_units" iu
        JOIN need_base nb ON nb.item_id = iu.item_id
        ORDER BY iu.item_id, iu.base_qty ASC, iu.id ASC
      )
      UPDATE "item_units"
         SET "is_base" = TRUE
       WHERE "id" IN (SELECT id FROM pick)
    `);

    // 5. Drop the legacy table (data lives in item_units now).
    await queryRunner.query(`DROP TABLE "item_switch"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Recreate item_switch (data not restored).
    await queryRunner.query(`
      CREATE TABLE "item_switch" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "item_number" TEXT NOT NULL REFERENCES "item_cart"("item_number") ON DELETE CASCADE,
        "barcode"     TEXT NOT NULL,
        "unit_qty"    INTEGER NOT NULL DEFAULT 1 CHECK ("unit_qty" > 0),
        "sale_price"  NUMERIC(14,2) NOT NULL CHECK ("sale_price" >= 0),
        "item_name"   TEXT NOT NULL,
        "unit_name"   TEXT NOT NULL,
        "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"  TIMESTAMPTZ,
        "version"     INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "uq_item_switch_barcode" UNIQUE ("barcode"),
        CONSTRAINT "uq_item_switch_item_unit" UNIQUE ("item_number", "unit_name")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_item_switch_item_number" ON "item_switch" ("item_number")`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_item_units_one_base"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "item_units"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "units"`);
  }
}
