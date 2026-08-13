import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer tax exemption, mirroring the ERP.
 *
 * Two halves, and the split is the whole point:
 *
 *   customers.*          the CURRENT state — editable, synced from the ERP, and the
 *                        thing a new voucher reads.
 *   voucher_headers.*    a SNAPSHOT frozen when the voucher is created.
 *
 * A certificate expires, gets revoked, or is corrected. A printed invoice must not
 * change its mind afterwards, and a RETURN months later has to reproduce the tax
 * treatment of the sale it reverses — not whatever the customer's status happens to
 * be that day. The ERP models it exactly this way (customers.* + invoices.*
 * snapshot columns), so the two systems agree document-for-document.
 */
export class CustomerTaxExemption1722700000000 implements MigrationInterface {
  name = 'CustomerTaxExemption1722700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "customers"
        ADD COLUMN "is_tax_exempt"             boolean NOT NULL DEFAULT false,
        ADD COLUMN "tax_exemption_type"        text,
        ADD COLUMN "tax_exemption_number"      text,
        ADD COLUMN "tax_exemption_reason"      text,
        ADD COLUMN "tax_exemption_valid_from"  timestamptz,
        ADD COLUMN "tax_exemption_valid_to"    timestamptz`);

    // Partial: exempt customers are the rare case, and every read is "is this one exempt".
    await q.query(`
      CREATE INDEX "idx_customers_tax_exempt"
        ON "customers" ("is_tax_exempt") WHERE "is_tax_exempt"`);

    await q.query(`
      ALTER TABLE "voucher_headers"
        ADD COLUMN "is_tax_exempt"                    boolean NOT NULL DEFAULT false,
        ADD COLUMN "tax_exemption_source"             text NOT NULL DEFAULT 'NONE',
        ADD COLUMN "tax_exemption_number_snapshot"    text,
        ADD COLUMN "tax_exemption_reason_snapshot"    text,
        ADD COLUMN "tax_exemption_type_snapshot"      text,
        ADD COLUMN "tax_exemption_applied_at"         timestamptz`);

    // Every voucher ever posted was taxed normally, so the default of false is a true
    // statement about history — no backfill, and no document silently becomes exempt.
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "voucher_headers"
        DROP COLUMN "tax_exemption_applied_at",
        DROP COLUMN "tax_exemption_type_snapshot",
        DROP COLUMN "tax_exemption_reason_snapshot",
        DROP COLUMN "tax_exemption_number_snapshot",
        DROP COLUMN "tax_exemption_source",
        DROP COLUMN "is_tax_exempt"`);
    await q.query(`DROP INDEX IF EXISTS "idx_customers_tax_exempt"`);
    await q.query(`
      ALTER TABLE "customers"
        DROP COLUMN "tax_exemption_valid_to",
        DROP COLUMN "tax_exemption_valid_from",
        DROP COLUMN "tax_exemption_reason",
        DROP COLUMN "tax_exemption_number",
        DROP COLUMN "tax_exemption_type",
        DROP COLUMN "is_tax_exempt"`);
  }
}
