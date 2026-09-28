import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Areas: where a customer is, as the office divides the map.
 *
 * Kept like segments — managed here, not in the ERP — but simpler: a customer
 * sits in exactly one area, so it is a column on the customer rather than a
 * membership table. Deleting an area leaves its customers with none.
 */
export class CustomerAreas1727900000000 implements MigrationInterface {
  name = 'CustomerAreas1727900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "customer_areas" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name_ar"    text NOT NULL,
        "name_en"    text,
        "color"      text,
        "is_active"  boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        "version"    integer NOT NULL DEFAULT 1
      )
    `);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_areas_name_ar"
         ON "customer_areas" ("name_ar") WHERE "deleted_at" IS NULL`,
    );
    await q.query(
      `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "area_id" uuid
         REFERENCES "customer_areas"("id") ON DELETE SET NULL`,
    );
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_customers_area" ON "customers" ("area_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_customers_area"`);
    await q.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "area_id"`);
    await q.query(`DROP TABLE IF EXISTS "customer_areas"`);
  }
}
