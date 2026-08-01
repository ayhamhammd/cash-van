import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Prospecting P2/P3: lead-finder searches and their candidate businesses.
 *
 * `prospects.google_place_id` is UNIQUE so re-searching an overlapping area
 * updates the existing lead instead of duplicating it — the rep's own status,
 * notes and outreach history survive repeated searches of the same street.
 * Coordinates are numeric(9,6), matching `customers.latitude/longitude`, so the
 * distance de-dup compares like with like.
 */
export class Prospects1721800000000 implements MigrationInterface {
  name = 'Prospects1721800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "prospect_searches" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "center_lat" numeric(9,6) NOT NULL,
        "center_lng" numeric(9,6) NOT NULL,
        "radius_m" integer NOT NULL,
        "categories" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "found_count" integer NOT NULL DEFAULT 0,
        "new_count" integer NOT NULL DEFAULT 0,
        "created_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "pk_prospect_searches" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "prospects" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "search_id" uuid,
        "google_place_id" text NOT NULL,
        "name" text NOT NULL,
        "lat" numeric(9,6),
        "lng" numeric(9,6),
        "address" text,
        "phone" text,
        "category" text,
        "rating" numeric(2,1),
        "status" text NOT NULL DEFAULT 'NEW',
        "matched_customer_id" uuid,
        "match_reason" text,
        "notes" text,
        "sent_at" timestamptz,
        "link_opened_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "pk_prospects" PRIMARY KEY ("id"),
        CONSTRAINT "uq_prospects_place_id" UNIQUE ("google_place_id"),
        CONSTRAINT "fk_prospects_search_id" FOREIGN KEY ("search_id")
          REFERENCES "prospect_searches"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_prospects_customer_id" FOREIGN KEY ("matched_customer_id")
          REFERENCES "customers"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_prospects_status" ON "prospects" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_prospects_search_id" ON "prospects" ("search_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "prospects"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "prospect_searches"`);
  }
}
