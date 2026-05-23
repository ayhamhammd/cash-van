import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plan 03 — Customers + AI Profile + Visits.
 *
 *  - Extends `customers` with VanFlow + JoFotara-buyer + AI-enrichment fields.
 *  - `customer_ai_profile`: nightly AI pipeline output (segment, churn, LTV).
 *  - `customer_visits`: mobile check-in log.
 *  - Arabic search: pg_trgm + simple tsvector (no PostGIS/snowball-arabic).
 *
 * Single-tenant deployment — no tenant_id / RLS.
 */
export class ExtendCustomersAndAddAiProfile1716000000000 implements MigrationInterface {
  name = 'ExtendCustomersAndAddAiProfile1716000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    // ---- customers extension ----------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "customers"
        ADD COLUMN "rep_id"          UUID,
        ADD COLUMN "name_ar"         TEXT,
        ADD COLUMN "name_en"         TEXT,
        ADD COLUMN "phone"           TEXT,
        ADD COLUMN "phone_hash"      TEXT,
        ADD COLUMN "address_ar"      TEXT,
        ADD COLUMN "city"            TEXT,
        ADD COLUMN "city_code"       TEXT,
        ADD COLUMN "region_id"       UUID,
        ADD COLUMN "category"        TEXT,
        ADD COLUMN "payment_terms"   INTEGER NOT NULL DEFAULT 30,
        ADD COLUMN "tin"             TEXT,
        ADD COLUMN "nin"             TEXT,
        ADD COLUMN "passport_number" TEXT,
        ADD COLUMN "is_active"       BOOLEAN NOT NULL DEFAULT TRUE
    `);

    // Backfill name_ar from existing customer_name.
    await queryRunner.query(`UPDATE "customers" SET "name_ar" = "customer_name" WHERE "name_ar" IS NULL`);
    await queryRunner.query(`ALTER TABLE "customers" ALTER COLUMN "name_ar" SET NOT NULL`);

    // FKs
    await queryRunner.query(`
      ALTER TABLE "customers"
        ADD CONSTRAINT "fk_customers_rep_id"
        FOREIGN KEY ("rep_id") REFERENCES "reps"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "customers"
        ADD CONSTRAINT "fk_customers_region_id"
        FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE SET NULL
    `);

    // Indexes
    await queryRunner.query(`CREATE INDEX "idx_customers_rep_id" ON "customers" ("rep_id")`);
    await queryRunner.query(`CREATE INDEX "idx_customers_region_id" ON "customers" ("region_id")`);
    await queryRunner.query(`CREATE INDEX "idx_customers_category" ON "customers" ("category")`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_customers_tin" ON "customers" ("tin") WHERE "tin" IS NOT NULL
    `);
    // Arabic-ish search: trigram for substring/fuzzy, simple tsvector for tokens.
    await queryRunner.query(`
      CREATE INDEX "idx_customers_name_ar_trgm" ON "customers" USING GIN ("name_ar" gin_trgm_ops)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_customers_name_ar_fts" ON "customers" USING GIN (to_tsvector('simple', "name_ar"))
    `);

    // ---- customer_ai_profile ----------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "customer_ai_profile" (
        "customer_id"       UUID PRIMARY KEY REFERENCES "customers"("id") ON DELETE CASCADE,
        "segment"           TEXT NOT NULL,
        "churn_score"       REAL NOT NULL,
        "churn_risk_label"  TEXT NOT NULL,
        "ltv_estimate"      INTEGER,
        "shap_drivers_json" JSONB,
        "model_version"     TEXT NOT NULL,
        "computed_at"       TIMESTAMPTZ NOT NULL,
        "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "ck_cap_churn_label"
          CHECK ("churn_risk_label" IN ('loyal','at_risk','high_risk'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_cap_churn_score_desc" ON "customer_ai_profile" ("churn_score" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_cap_segment" ON "customer_ai_profile" ("segment")
    `);

    // ---- customer_visits ---------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "customer_visits" (
        "id"          BIGSERIAL PRIMARY KEY,
        "customer_id" UUID NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
        "rep_id"      UUID NOT NULL REFERENCES "reps"("id") ON DELETE CASCADE,
        "visited_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "had_sale"    BOOLEAN NOT NULL DEFAULT FALSE,
        "visit_note"  TEXT,
        "lat"         DOUBLE PRECISION,
        "lng"         DOUBLE PRECISION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_cv_customer_visited_desc" ON "customer_visits" ("customer_id", "visited_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_cv_rep_visited_desc" ON "customer_visits" ("rep_id", "visited_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_visits"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_ai_profile"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_customers_name_ar_fts"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_customers_name_ar_trgm"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_customers_tin"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_customers_category"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_customers_region_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_customers_rep_id"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "fk_customers_region_id"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "fk_customers_rep_id"`);
    await queryRunner.query(`
      ALTER TABLE "customers"
        DROP COLUMN IF EXISTS "rep_id",
        DROP COLUMN IF EXISTS "name_ar",
        DROP COLUMN IF EXISTS "name_en",
        DROP COLUMN IF EXISTS "phone",
        DROP COLUMN IF EXISTS "phone_hash",
        DROP COLUMN IF EXISTS "address_ar",
        DROP COLUMN IF EXISTS "city",
        DROP COLUMN IF EXISTS "city_code",
        DROP COLUMN IF EXISTS "region_id",
        DROP COLUMN IF EXISTS "category",
        DROP COLUMN IF EXISTS "payment_terms",
        DROP COLUMN IF EXISTS "tin",
        DROP COLUMN IF EXISTS "nin",
        DROP COLUMN IF EXISTS "passport_number",
        DROP COLUMN IF EXISTS "is_active"
    `);
  }
}
