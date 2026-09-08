import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ERP-raised invoices, mirrored so a salesman is credited for them.
 *
 * The office invoices a shop directly in the ERP. That sale exists in no
 * cash-van voucher, so the rep who services the shop saw none of it: not on the
 * customer's statement, and not on their target, which counts voucher_headers
 * and nothing else. A rep could serve a customer all month and show zero.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * Invoices cash-van itself pushed to the ERP. They come back over the same
 * endpoint marked `origin: VAN_SALES`, and mirroring them would count one van
 * sale twice — once as the voucher this database already holds, and again as
 * the ERP invoice that voucher created. `origin` is stored anyway so the skip is
 * auditable rather than invisible.
 *
 * `rep_id` is resolved at sync from the customer's assignment and stored rather
 * than joined at read time: reassigning a customer must not silently rewrite
 * last month's achieved figure for the rep who actually did the work.
 */
export class ErpInvoices1726400000000 implements MigrationInterface {
  name = 'ErpInvoices1726400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "erp_invoices" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now(),
        "deleted_at"      timestamptz,
        "version"         integer NOT NULL DEFAULT 1,
        "erp_id"          text NOT NULL,
        "invoice_number"  text,
        "issued_at"       timestamptz NOT NULL,
        "erp_customer_id" text,
        "customer_id"     uuid REFERENCES "customers"("id"),
        "rep_id"          uuid REFERENCES "reps"("id"),
        "salesman_name"   text,
        "status"          text,
        "origin"          text NOT NULL DEFAULT 'ERP',
        "total_fils"      bigint NOT NULL DEFAULT 0,
        "tax_fils"        bigint NOT NULL DEFAULT 0,
        "paid_fils"       bigint NOT NULL DEFAULT 0,
        "synced_at"       timestamptz
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_invoices_erp_id" ON "erp_invoices" ("erp_id")`,
    );
    // The target query asks "this rep, this month", so the index leads on the
    // rep and then the date.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_erp_invoices_rep_date" ON "erp_invoices" ("rep_id", "issued_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_erp_invoices_customer" ON "erp_invoices" ("customer_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "erp_invoices"`);
  }
}
