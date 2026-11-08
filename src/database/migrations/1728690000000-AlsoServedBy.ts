import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two salesmen in one area (docs/SPEC-location-tree.md §5.6, Q1).
 *
 * A shop keeps ONE main salesman — customers.rep_id, who owns its debt,
 * statement, reports and the ERP's salesman field. Other salesmen can ALSO
 * serve it (a cold-drinks van and a snacks van): they see it on their phone,
 * can sell and collect there, and can put it on their route.
 *
 * location_extra_reps — salesmen who also serve every customer under a place
 *                       (a governorate's apply to all its areas). TREE mode.
 * customer_extra_reps — salesmen who also serve one customer, chosen for it.
 *
 * Not materialised into customers: who also serves a shop is read through
 * the shop's path when it is asked, so nothing can drift. Nothing that reads
 * rep_id changes.
 */
export class AlsoServedBy1728690000000 implements MigrationInterface {
  name = 'AlsoServedBy1728690000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE IF NOT EXISTS "location_extra_reps" (
         "location_id" uuid NOT NULL REFERENCES "locations"("id") ON DELETE CASCADE,
         "rep_id"      uuid NOT NULL REFERENCES "reps"("id") ON DELETE CASCADE,
         "created_at"  timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY ("location_id", "rep_id")
       )`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_location_extra_reps_rep" ON "location_extra_reps" ("rep_id")`,
    );
    await q.query(
      `CREATE TABLE IF NOT EXISTS "customer_extra_reps" (
         "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
         "rep_id"      uuid NOT NULL REFERENCES "reps"("id") ON DELETE CASCADE,
         "created_at"  timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY ("customer_id", "rep_id")
       )`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_customer_extra_reps_rep" ON "customer_extra_reps" ("rep_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "customer_extra_reps"`);
    await q.query(`DROP TABLE IF EXISTS "location_extra_reps"`);
  }
}
