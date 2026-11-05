import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The location tree: Jordan › governorates › areas.
 *
 * A second way to say where a customer is, next to the flat customer_areas
 * list, chosen by app_settings.location_mode. Both live side by side — a
 * customer keeps its area_id when it gains a location_id — so the office can
 * switch modes back and forth without losing either. Nothing is seeded: every
 * company stays FLAT until an admin builds a tree and switches.
 *
 * See docs/SPEC-location-tree.md.
 */
export class LocationTree1728590000000 implements MigrationInterface {
  name = 'LocationTree1728590000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "locations" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "parent_id"  uuid REFERENCES "locations"("id") ON DELETE RESTRICT,
        "kind"       text NOT NULL CHECK ("kind" IN ('COUNTRY','GOVERNORATE','AREA')),
        "path"       text NOT NULL,
        "depth"      smallint NOT NULL,
        "code"       text,
        "name_ar"    text NOT NULL,
        "name_en"    text,
        "color"      text,
        "sort_order" integer NOT NULL DEFAULT 0,
        "is_active"  boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        "version"    integer NOT NULL DEFAULT 1,
        CONSTRAINT "chk_locations_root" CHECK (("kind" = 'COUNTRY') = ("parent_id" IS NULL))
      )
    `);
    // Sibling names are unique; the root's "parent" is the zero uuid so the
    // index covers it too (a NULL would never collide).
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_locations_sibling_name"
         ON "locations" (COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::uuid), "name_ar")
        WHERE "deleted_at" IS NULL`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_locations_gov_code"
         ON "locations" ("code")
        WHERE "kind" = 'GOVERNORATE' AND "code" IS NOT NULL AND "deleted_at" IS NULL`,
    );
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_locations_parent" ON "locations" ("parent_id")`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_locations_path" ON "locations" ("path" text_pattern_ops)`,
    );

    await q.query(
      `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "location_id" uuid
         REFERENCES "locations"("id") ON DELETE SET NULL`,
    );
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_customers_location" ON "customers" ("location_id")`);

    await q.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "location_mode" text NOT NULL DEFAULT 'FLAT'`,
    );
    await q.query(`ALTER TABLE "app_settings" DROP CONSTRAINT IF EXISTS "chk_app_settings_location_mode"`);
    await q.query(
      `ALTER TABLE "app_settings" ADD CONSTRAINT "chk_app_settings_location_mode"
         CHECK ("location_mode" IN ('FLAT','TREE'))`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "app_settings" DROP CONSTRAINT IF EXISTS "chk_app_settings_location_mode"`);
    await q.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "location_mode"`);
    await q.query(`DROP INDEX IF EXISTS "idx_customers_location"`);
    await q.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "location_id"`);
    await q.query(`DROP TABLE IF EXISTS "locations"`);
  }
}
