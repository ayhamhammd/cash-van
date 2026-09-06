import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quarantine inventory for damaged/expired returns (mirrors van_stock).
 * Populated only when the damaged-returns feature is on. See
 * docs/SPEC-damaged-expired-returns.md.
 */
export class DamagedStock1725900000000 implements MigrationInterface {
  name = 'DamagedStock1725900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "damaged_stock" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "rep_id" uuid NOT NULL,
        "product_id" uuid NOT NULL,
        "stock_unit_code" text NOT NULL DEFAULT '',
        "quantity" integer NOT NULL DEFAULT 0,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_damaged_stock" PRIMARY KEY ("id"),
        CONSTRAINT "uq_damaged_stock_rep_product_unit" UNIQUE ("rep_id", "product_id", "stock_unit_code")
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_damaged_stock_rep" ON "damaged_stock" ("rep_id")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_damaged_stock_product" ON "damaged_stock" ("product_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "damaged_stock"`);
  }
}
