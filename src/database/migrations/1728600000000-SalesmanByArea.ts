import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Salesmen by area (docs/SPEC-location-tree.md §5).
 *
 * locations.rep_id — the salesman covering a node; a node without one
 * inherits the nearest one above it.
 *
 * customers.rep_source — why rep_id holds what it holds:
 *   DIRECT  someone chose this salesman for this customer; an area change
 *           never overrides it.
 *   AREA    rep_id was resolved from the customer's area and follows it.
 *   NULL    no salesman (or a row written before this column — see below).
 *
 * The resolved salesman is written INTO customers.rep_id, so the phone's
 * customer list, reports, AR, targets, journey plans and supervisor scope
 * keep reading the one column they read today.
 *
 * Backfill: every customer that has a salesman today got him by somebody's
 * choice, so it is DIRECT. Nothing moves until an admin assigns an area.
 */
export class SalesmanByArea1728600000000 implements MigrationInterface {
  name = 'SalesmanByArea1728600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "rep_id" uuid
         REFERENCES "reps"("id") ON DELETE SET NULL`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_locations_rep" ON "locations" ("rep_id") WHERE "rep_id" IS NOT NULL`,
    );
    await q.query(`ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "rep_source" text`);
    await q.query(`ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "chk_customers_rep_source"`);
    await q.query(
      `ALTER TABLE "customers" ADD CONSTRAINT "chk_customers_rep_source"
         CHECK ("rep_source" IN ('DIRECT','AREA'))`,
    );
    await q.query(
      `UPDATE "customers" SET "rep_source" = 'DIRECT' WHERE "rep_id" IS NOT NULL AND "rep_source" IS NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "chk_customers_rep_source"`);
    await q.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "rep_source"`);
    await q.query(`DROP INDEX IF EXISTS "idx_locations_rep"`);
    await q.query(`ALTER TABLE "locations" DROP COLUMN IF EXISTS "rep_id"`);
  }
}
