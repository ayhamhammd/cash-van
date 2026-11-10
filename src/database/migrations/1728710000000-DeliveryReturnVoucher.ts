import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The CashVan RETURN voucher an approved delivery return becomes.
 *
 * The ERP issues the credit note (the one return the ERP gets); CashVan writes
 * the matching RETURN voucher for its own lists and reports, numbered
 * `ERP-RET-<credit note>` so no path ever pushes it back. The stop remembers
 * it, which is what the dashboard links to and what makes a second build a
 * no-op. Unique: one voucher per stop, and a voucher belongs to one stop.
 */
export class DeliveryReturnVoucher1728710000000 implements MigrationInterface {
  name = 'DeliveryReturnVoucher1728710000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "delivery_stops"
        ADD COLUMN IF NOT EXISTS "return_voucher_number" text,
        ADD COLUMN IF NOT EXISTS "return_voucher_id" uuid`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_delivery_stops_return_voucher"
         ON "delivery_stops" ("return_voucher_number") WHERE "return_voucher_number" IS NOT NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "uq_delivery_stops_return_voucher"`);
    await q.query(`
      ALTER TABLE "delivery_stops"
        DROP COLUMN IF EXISTS "return_voucher_id",
        DROP COLUMN IF EXISTS "return_voucher_number"`);
  }
}
