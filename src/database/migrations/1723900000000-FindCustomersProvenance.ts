import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Find customers" on the salesman app: the permission that reveals it, and
 * the provenance that survives it.
 *
 * `can_find_customers` follows every other capability on this table — default
 * FALSE, so no salesman gains the screen on upgrade until the office grants
 * it. Note this is a VISIBILITY flag: /prospecting/* carries no @Roles guard,
 * so a rep with it off could still reach the API directly. Making it a real
 * boundary means guarding the controller, which this migration does not do.
 *
 * `customers.source` exists because the link between a lead and the customer
 * it became was one-directional: prospects.matched_customer_id points AT the
 * customer, and nothing on the customer points back. Answering "how many of
 * this month's customers came from prospecting?" meant a join per row with no
 * useful index. Now it is a column on the row being counted.
 *
 * Existing customers become 'MANUAL', which is the truthful answer for
 * anything created before prospecting could file one.
 */
export class FindCustomersProvenance1723900000000 implements MigrationInterface {
  name = 'FindCustomersProvenance1723900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "can_find_customers" boolean NOT NULL DEFAULT false`,
    );

    await queryRunner.query(
      `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'MANUAL'`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "source_prospect_id" uuid`,
    );

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'ck_customers_source'
        ) THEN
          ALTER TABLE "customers" ADD CONSTRAINT "ck_customers_source"
            CHECK ("source" IN ('MANUAL', 'PROSPECTING', 'IMPORT', 'ERP'));
        END IF;
      END $$;
    `);

    // The report counts new customers per source over a date window, so it
    // reads both columns together.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_customers_source_created"
         ON "customers" ("source", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_customers_source_prospect"
         ON "customers" ("source_prospect_id") WHERE "source_prospect_id" IS NOT NULL`,
    );

    // Backfill from the one-directional link that already exists, so customers
    // converted from the dashboard before today are not misreported as MANUAL.
    await queryRunner.query(`
      UPDATE "customers" c
         SET "source" = 'PROSPECTING', "source_prospect_id" = p."id"
        FROM "prospects" p
       WHERE p."matched_customer_id" = c."id"
         AND p."status" = 'CONVERTED'
         AND c."source" = 'MANUAL'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_customers_source_prospect"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_customers_source_created"`);
    await queryRunner.query(
      `ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "ck_customers_source"`,
    );
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "source_prospect_id"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "source"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "can_find_customers"`);
  }
}
