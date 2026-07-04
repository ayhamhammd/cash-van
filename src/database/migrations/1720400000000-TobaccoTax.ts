import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tobacco ("smoke") tax — Phase 1 schema. Mirrors the ERP tobacco tax model:
 *   • tobacco_tax_profiles      — the profiles (sales / special-excise / withheld)
 *   • item_cart.*               — per-item tobacco flag + profile + consumer price
 *   • voucher_transactions.*    — the per-line tax snapshot (frozen at sale time)
 *   • app_settings.tobacco_tax_enabled — master toggle (OFF ⇒ no behavior change)
 *
 * All money columns are integer fils. See docs/SPEC-tobacco-tax.md.
 */
export class TobaccoTax1720400000000 implements MigrationInterface {
  name = 'TobaccoTax1720400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tobacco_tax_profiles" (
        "id"                            uuid NOT NULL DEFAULT uuid_generate_v4(),
        "erp_id"                        text,
        "name"                          text NOT NULL,
        "description"                   text,
        "tax_base"                      text NOT NULL DEFAULT 'CONSUMER_PRICE',
        "sales_tax_enabled"             boolean NOT NULL DEFAULT true,
        "sales_tax_rate"                integer NOT NULL DEFAULT 0,
        "special_tax_enabled"           boolean NOT NULL DEFAULT false,
        "special_tax_calculation_type"  text NOT NULL DEFAULT 'NONE',
        "special_tax_base"              text NOT NULL DEFAULT 'QUANTITY',
        "special_tax_rate"              integer,
        "special_tax_fixed_amount"      integer,
        "withheld_tax_enabled"          boolean NOT NULL DEFAULT false,
        "withheld_tax_calculation_type" text NOT NULL DEFAULT 'NONE',
        "withheld_tax_base"             text NOT NULL DEFAULT 'GROSS_TAX',
        "withheld_tax_amount"           integer,
        "withheld_tax_rate"             integer,
        "tax_included_in_consumer_price" boolean NOT NULL DEFAULT false,
        "effective_from"                date,
        "effective_to"                  date,
        "is_active"                     boolean NOT NULL DEFAULT true,
        "created_at"                    timestamptz NOT NULL DEFAULT now(),
        "updated_at"                    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tobacco_tax_profiles" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_tobacco_profile_erp_id"
        ON "tobacco_tax_profiles" ("erp_id") WHERE "erp_id" IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "item_cart"
        ADD COLUMN IF NOT EXISTS "is_tobacco_product"     boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "tobacco_tax_profile_id" uuid,
        ADD COLUMN IF NOT EXISTS "consumer_price_fils"    integer
    `);

    await queryRunner.query(`
      ALTER TABLE "voucher_transactions"
        ADD COLUMN IF NOT EXISTS "is_tobacco_line"                 boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "tobacco_tax_profile_id"          text,
        ADD COLUMN IF NOT EXISTS "consumer_price_fils"             integer,
        ADD COLUMN IF NOT EXISTS "consumer_value_fils"             integer,
        ADD COLUMN IF NOT EXISTS "tobacco_tax_base_fils"           integer,
        ADD COLUMN IF NOT EXISTS "tobacco_sales_tax_rate"          integer,
        ADD COLUMN IF NOT EXISTS "tobacco_sales_tax_fils"          integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "tobacco_special_tax_calc_type"   text,
        ADD COLUMN IF NOT EXISTS "tobacco_special_tax_rate"        integer,
        ADD COLUMN IF NOT EXISTS "tobacco_special_tax_fixed_fils"  integer,
        ADD COLUMN IF NOT EXISTS "tobacco_special_tax_fils"        integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "tobacco_withheld_tax_calc_type"  text,
        ADD COLUMN IF NOT EXISTS "tobacco_withheld_tax_rate"       integer,
        ADD COLUMN IF NOT EXISTS "tobacco_withheld_tax_fixed_fils" integer,
        ADD COLUMN IF NOT EXISTS "tobacco_withheld_tax_fils"       integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "tobacco_gross_tax_fils"          integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "tobacco_net_tax_fils"            integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "tobacco_calc_details"            jsonb
    `);

    await queryRunner.query(`
      ALTER TABLE "app_settings"
        ADD COLUMN IF NOT EXISTS "tobacco_tax_enabled" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "tobacco_tax_enabled"`);
    await queryRunner.query(`
      ALTER TABLE "voucher_transactions"
        DROP COLUMN IF EXISTS "is_tobacco_line",
        DROP COLUMN IF EXISTS "tobacco_tax_profile_id",
        DROP COLUMN IF EXISTS "consumer_price_fils",
        DROP COLUMN IF EXISTS "consumer_value_fils",
        DROP COLUMN IF EXISTS "tobacco_tax_base_fils",
        DROP COLUMN IF EXISTS "tobacco_sales_tax_rate",
        DROP COLUMN IF EXISTS "tobacco_sales_tax_fils",
        DROP COLUMN IF EXISTS "tobacco_special_tax_calc_type",
        DROP COLUMN IF EXISTS "tobacco_special_tax_rate",
        DROP COLUMN IF EXISTS "tobacco_special_tax_fixed_fils",
        DROP COLUMN IF EXISTS "tobacco_special_tax_fils",
        DROP COLUMN IF EXISTS "tobacco_withheld_tax_calc_type",
        DROP COLUMN IF EXISTS "tobacco_withheld_tax_rate",
        DROP COLUMN IF EXISTS "tobacco_withheld_tax_fixed_fils",
        DROP COLUMN IF EXISTS "tobacco_withheld_tax_fils",
        DROP COLUMN IF EXISTS "tobacco_gross_tax_fils",
        DROP COLUMN IF EXISTS "tobacco_net_tax_fils",
        DROP COLUMN IF EXISTS "tobacco_calc_details"
    `);
    await queryRunner.query(`
      ALTER TABLE "item_cart"
        DROP COLUMN IF EXISTS "is_tobacco_product",
        DROP COLUMN IF EXISTS "tobacco_tax_profile_id",
        DROP COLUMN IF EXISTS "consumer_price_fils"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "tobacco_tax_profiles"`);
  }
}
