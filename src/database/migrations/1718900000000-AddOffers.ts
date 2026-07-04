import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Offers engine — offer definitions, their redemptions, and the link from a
 * sale back to the offers applied to it.
 *
 *   offers              — type-first promotion definitions (trigger/reward/
 *                         eligibility as jsonb; soft-deletable, versioned).
 *   offer_redemptions   — one row per (offer × sale) the offer was applied to.
 *   voucher_headers.applied_offer_ids — offer ids stamped on the sale.
 */
export class AddOffers1718900000000 implements MigrationInterface {
  name = 'AddOffers1718900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "offers" (
        "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"                   text NOT NULL,
        "description"            text,
        "type"                   text NOT NULL,
        "trigger"                jsonb NOT NULL DEFAULT '{}'::jsonb,
        "reward"                 jsonb NOT NULL DEFAULT '{}'::jsonb,
        "eligibility"            jsonb NOT NULL DEFAULT '{"customerScope":"ALL"}'::jsonb,
        "valid_from"             timestamptz,
        "valid_to"               timestamptz,
        "days_of_week"           jsonb,
        "time_from"              text,
        "time_to"                text,
        "total_redemption_limit" integer,
        "per_customer_limit"     integer,
        "priority"               integer NOT NULL DEFAULT 0,
        "stackable"              boolean NOT NULL DEFAULT false,
        "is_active"              boolean NOT NULL DEFAULT true,
        "redemption_count"       integer NOT NULL DEFAULT 0,
        "created_at"             timestamptz NOT NULL DEFAULT now(),
        "updated_at"             timestamptz NOT NULL DEFAULT now(),
        "deleted_at"             timestamptz,
        "version"                integer NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_offers_active" ON "offers" ("is_active")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_offers_type" ON "offers" ("type")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "offer_redemptions" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "offer_id"        uuid NOT NULL REFERENCES "offers" ("id") ON DELETE CASCADE,
        "voucher_number"  text,
        "customer_number" text,
        "discount_fils"   integer NOT NULL DEFAULT 0,
        "free_items"      jsonb NOT NULL DEFAULT '[]'::jsonb,
        "created_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_offer_redemptions_offer"
         ON "offer_redemptions" ("offer_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_offer_redemptions_customer"
         ON "offer_redemptions" ("offer_id", "customer_number")`,
    );

    await queryRunner.query(
      `ALTER TABLE "voucher_headers"
         ADD COLUMN IF NOT EXISTS "applied_offer_ids" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "voucher_headers" DROP COLUMN IF EXISTS "applied_offer_ids"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "offer_redemptions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "offers"`);
  }
}
