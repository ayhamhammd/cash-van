import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Carry the ERP's price-list tiers instead of flattening them.
 *
 * The ERP prices an item per quantity band and per date window
 * (`minQty`/`maxQty`/`startDate`/`endDate`/`isActive`, all returned by
 * GET /api/v1/price-lists/{id}). The mirror kept ONE row per item — the
 * cheapest tier — so a list reading "1-9 → 1.000, 10+ → 0.900" charged 0.900
 * for a single unit. The old unique index made it structurally impossible to
 * store the bands at all.
 *
 * Identity for an ERP-owned row is the ERP's own price-list-item id, so a tier
 * can be re-priced, re-banded or withdrawn and still be recognised. Local
 * (dashboard-authored) rows keep the old one-per-item rule, which is why the two
 * uniqueness rules are PARTIAL rather than one index over both.
 */
export class PriceListItemTiers1725400000000 implements MigrationInterface {
  name = 'PriceListItemTiers1725400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "price_list_items"
        ADD COLUMN IF NOT EXISTS "erp_item_id" text,
        ADD COLUMN IF NOT EXISTS "min_qty"     integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "max_qty"     integer,
        ADD COLUMN IF NOT EXISTS "start_date"  date,
        ADD COLUMN IF NOT EXISTS "end_date"    date,
        ADD COLUMN IF NOT EXISTS "is_active"   boolean NOT NULL DEFAULT true
    `);

    // The old rule allowed one row per (list, item) for EVERY row. Tiers need
    // several, so it is replaced by two partial rules: ERP rows are identified
    // by their ERP id, local rows keep one-per-item exactly as before.
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_price_list_item"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_price_list_item_erp"
        ON "price_list_items" ("erp_item_id")
        WHERE "erp_item_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_price_list_item_local"
        ON "price_list_items" ("price_list_id", "item_id")
        WHERE "erp_item_id" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_price_list_items_lookup"
        ON "price_list_items" ("price_list_id", "item_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_price_list_items_lookup"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_price_list_item_local"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_price_list_item_erp"`);
    // Collapse back to one row per (list, item) — keep the cheapest, which is
    // what the flattening mirror used to store — before restoring the old index.
    await queryRunner.query(`
      DELETE FROM "price_list_items" a
       USING "price_list_items" b
       WHERE a."price_list_id" = b."price_list_id"
         AND a."item_id"       = b."item_id"
         AND (a."unit_price" > b."unit_price"
              OR (a."unit_price" = b."unit_price" AND a."id" > b."id"))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_price_list_item"
        ON "price_list_items" ("price_list_id", "item_id")
    `);
    await queryRunner.query(`
      ALTER TABLE "price_list_items"
        DROP COLUMN IF EXISTS "is_active",
        DROP COLUMN IF EXISTS "end_date",
        DROP COLUMN IF EXISTS "start_date",
        DROP COLUMN IF EXISTS "max_qty",
        DROP COLUMN IF EXISTS "min_qty",
        DROP COLUMN IF EXISTS "erp_item_id"
    `);
  }
}
