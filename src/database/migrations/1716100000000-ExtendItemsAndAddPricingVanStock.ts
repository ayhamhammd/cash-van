import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plan 04 — Products, Categories, Van Stock, Pricing.
 *
 *  - Extends `item_cart` (a.k.a. products) with SKU, bilingual names, category,
 *    fils price/cost, tax classification, and stock flags.
 *  - `product_categories`: self-referencing tree.
 *  - `van_stock`: current per-rep loaded quantity (upsert on rep+product).
 *  - `price_rules`: quantity / segment discount tiers.
 *
 * Single-tenant — no tenant_id / RLS. Money in INTEGER fils.
 */
export class ExtendItemsAndAddPricingVanStock1716100000000 implements MigrationInterface {
  name = 'ExtendItemsAndAddPricingVanStock1716100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- product_categories (created first so item_cart FK resolves) -------
    await queryRunner.query(`
      CREATE TABLE "product_categories" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name_ar"    TEXT NOT NULL,
        "name_en"    TEXT,
        "parent_id"  UUID REFERENCES "product_categories"("id") ON DELETE SET NULL,
        "sort_order" INTEGER NOT NULL DEFAULT 0,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMPTZ,
        "version"    INTEGER NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_product_categories_parent_sort"
        ON "product_categories" ("parent_id", "sort_order")
    `);

    // ---- item_cart extension ----------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "item_cart"
        ADD COLUMN "sku"             TEXT,
        ADD COLUMN "name_ar"         TEXT,
        ADD COLUMN "name_en"         TEXT,
        ADD COLUMN "category_id"     UUID REFERENCES "product_categories"("id") ON DELETE SET NULL,
        ADD COLUMN "unit"            TEXT NOT NULL DEFAULT 'carton',
        ADD COLUMN "unit_of_measure" TEXT NOT NULL DEFAULT 'PCE',
        ADD COLUMN "price"           INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN "cost"            INTEGER,
        ADD COLUMN "image_url"       TEXT,
        ADD COLUMN "is_active"       BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN "reorder_qty"     INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN "tax_type"        TEXT NOT NULL DEFAULT 'TAXABLE',
        ADD COLUMN "tax_category"    TEXT NOT NULL DEFAULT 'S',
        ADD COLUMN "tax_rate"        NUMERIC(5,4) NOT NULL DEFAULT 0.16
    `);

    // Backfill: sku/name_ar from legacy columns; image_url from photo_url.
    await queryRunner.query(`UPDATE "item_cart" SET "sku" = "item_number" WHERE "sku" IS NULL`);
    await queryRunner.query(`UPDATE "item_cart" SET "name_ar" = "item_name" WHERE "name_ar" IS NULL`);
    await queryRunner.query(`UPDATE "item_cart" SET "image_url" = "photo_url" WHERE "image_url" IS NULL AND "photo_url" IS NOT NULL`);
    await queryRunner.query(`UPDATE "item_cart" SET "tax_rate" = ("tax_percentage" / 100.0)`);
    await queryRunner.query(`
      UPDATE "item_cart" SET "tax_category" = CASE WHEN "tax_percentage" = 0 THEN 'E' ELSE 'S' END
    `);

    // Backfill price (fils) from the base unit (unit_qty = 1) in item_switch.
    await queryRunner.query(`
      UPDATE "item_cart" ic SET "price" = sub.fils
      FROM (
        SELECT DISTINCT ON (item_number) item_number,
               ROUND(sale_price * 1000)::int AS fils
        FROM "item_switch"
        ORDER BY item_number, unit_qty ASC
      ) sub
      WHERE ic."item_number" = sub.item_number
    `);

    await queryRunner.query(`ALTER TABLE "item_cart" ALTER COLUMN "name_ar" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "item_cart" ALTER COLUMN "sku" SET NOT NULL`);
    await queryRunner.query(`
      ALTER TABLE "item_cart"
        ADD CONSTRAINT "ck_item_cart_tax_type" CHECK ("tax_type" IN ('TAXABLE','INCLUSIVE','EXEMPT')),
        ADD CONSTRAINT "ck_item_cart_tax_category" CHECK ("tax_category" IN ('S','Z','E'))
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_item_cart_sku" ON "item_cart" ("sku")`);
    await queryRunner.query(`
      CREATE INDEX "idx_item_cart_category_active" ON "item_cart" ("category_id", "is_active")
    `);

    // ---- van_stock ---------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "van_stock" (
        "id"          BIGSERIAL PRIMARY KEY,
        "rep_id"      UUID NOT NULL REFERENCES "reps"("id") ON DELETE CASCADE,
        "product_id"  UUID NOT NULL REFERENCES "item_cart"("id") ON DELETE CASCADE,
        "quantity"    INTEGER NOT NULL DEFAULT 0,
        "loaded_at"   TIMESTAMPTZ,
        "snapshot_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "uq_van_stock_rep_product" UNIQUE ("rep_id", "product_id"),
        CONSTRAINT "ck_van_stock_qty_nonneg" CHECK ("quantity" >= 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_van_stock_rep" ON "van_stock" ("rep_id")`);
    await queryRunner.query(`CREATE INDEX "idx_van_stock_product" ON "van_stock" ("product_id")`);

    // ---- price_rules -------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "price_rules" (
        "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "product_id"       UUID REFERENCES "item_cart"("id") ON DELETE CASCADE,
        "customer_segment" TEXT,
        "min_qty"          INTEGER NOT NULL DEFAULT 1,
        "discount_pct"     REAL NOT NULL DEFAULT 0,
        "fixed_price"      INTEGER,
        "valid_from"       DATE,
        "valid_to"         DATE,
        "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"       TIMESTAMPTZ,
        "version"          INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "ck_price_rules_min_qty" CHECK ("min_qty" >= 1),
        CONSTRAINT "ck_price_rules_discount" CHECK ("discount_pct" >= 0 AND "discount_pct" <= 100)
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_price_rules_product" ON "price_rules" ("product_id")`);
    await queryRunner.query(`CREATE INDEX "idx_price_rules_validity" ON "price_rules" ("valid_from", "valid_to")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "price_rules"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "van_stock"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_item_cart_category_active"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_item_cart_sku"`);
    await queryRunner.query(`
      ALTER TABLE "item_cart"
        DROP CONSTRAINT IF EXISTS "ck_item_cart_tax_type",
        DROP CONSTRAINT IF EXISTS "ck_item_cart_tax_category"
    `);
    await queryRunner.query(`
      ALTER TABLE "item_cart"
        DROP COLUMN IF EXISTS "sku",
        DROP COLUMN IF EXISTS "name_ar",
        DROP COLUMN IF EXISTS "name_en",
        DROP COLUMN IF EXISTS "category_id",
        DROP COLUMN IF EXISTS "unit",
        DROP COLUMN IF EXISTS "unit_of_measure",
        DROP COLUMN IF EXISTS "price",
        DROP COLUMN IF EXISTS "cost",
        DROP COLUMN IF EXISTS "image_url",
        DROP COLUMN IF EXISTS "is_active",
        DROP COLUMN IF EXISTS "reorder_qty",
        DROP COLUMN IF EXISTS "tax_type",
        DROP COLUMN IF EXISTS "tax_category",
        DROP COLUMN IF EXISTS "tax_rate"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "product_categories"`);
  }
}
