import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plan 06 — Sales Invoices & Approval.
 *
 *  - `invoices`: VanFlow sales invoices with full Jordan-tax breakdown (fils)
 *    and JoFotara/ISTD lifecycle fields (populated by plan 11).
 *  - `invoice_lines`: per-line tax snapshot + calculation breakdown.
 *  - `invoice_approvals`: approval audit trail.
 *  - `invoice_number_seq`: global sequence → INV-{YYYY}-{NNNNNN}.
 *  - bridge: `voucher_headers.invoice_id` links a sales invoice to its legacy GL voucher.
 *
 * Single-tenant — no tenant_id / RLS. Money in INTEGER fils.
 */
export class AddInvoicesAndApprovals1716300000000 implements MigrationInterface {
  name = 'AddInvoicesAndApprovals1716300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS "invoice_number_seq" START 1`);

    await queryRunner.query(`
      CREATE TABLE "invoices" (
        "id"                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "rep_id"                       UUID NOT NULL REFERENCES "reps"("id") ON DELETE RESTRICT,
        "customer_id"                  UUID NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
        "invoice_number"               TEXT NOT NULL,
        "status"                       TEXT NOT NULL DEFAULT 'draft',
        "subtotal"                     INTEGER NOT NULL DEFAULT 0,
        "total_line_discounts"         INTEGER NOT NULL DEFAULT 0,
        "invoice_discount_amount"      INTEGER NOT NULL DEFAULT 0,
        "net_taxable"                  INTEGER NOT NULL DEFAULT 0,
        "net_inclusive"                INTEGER NOT NULL DEFAULT 0,
        "net_exempt"                   INTEGER NOT NULL DEFAULT 0,
        "tax_on_taxable"               INTEGER NOT NULL DEFAULT 0,
        "tax_extracted_from_inclusive" INTEGER NOT NULL DEFAULT 0,
        "total_tax"                    INTEGER NOT NULL DEFAULT 0,
        "grand_total"                  INTEGER NOT NULL DEFAULT 0,
        "invoice_type_code"            TEXT NOT NULL DEFAULT '011',
        "payment_method_code"          TEXT NOT NULL DEFAULT '012',
        "jofotara_uuid"                UUID,
        "jofotara_status"              TEXT NOT NULL DEFAULT 'PENDING',
        "jofotara_qr_code"             TEXT,
        "jofotara_registration_number" TEXT,
        "jofotara_error_code"          TEXT,
        "jofotara_error_message"       TEXT,
        "jofotara_submitted_at"        TIMESTAMPTZ,
        "has_credit_notes"             BOOLEAN NOT NULL DEFAULT FALSE,
        "note"                         TEXT,
        "device_id"                    TEXT,
        "created_at"                   TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"                   TIMESTAMPTZ NOT NULL DEFAULT now(),
        "confirmed_at"                 TIMESTAMPTZ,
        "cancelled_at"                 TIMESTAMPTZ,
        CONSTRAINT "uq_invoices_invoice_number" UNIQUE ("invoice_number"),
        CONSTRAINT "ck_invoices_status"
          CHECK ("status" IN ('draft','confirmed','pending_approval','rejected','cancelled')),
        CONSTRAINT "ck_invoices_jofotara_status"
          CHECK ("jofotara_status" IN ('PENDING','SUBMITTED','VALIDATED','REJECTED','ERROR')),
        CONSTRAINT "ck_invoices_type_code" CHECK ("invoice_type_code" IN ('011','021','381')),
        CONSTRAINT "ck_invoices_payment_code" CHECK ("payment_method_code" IN ('012','022'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_invoices_rep_created" ON "invoices" ("rep_id", "created_at" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_invoices_status_created" ON "invoices" ("status", "created_at" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_invoices_customer" ON "invoices" ("customer_id")`);

    await queryRunner.query(`
      CREATE TABLE "invoice_lines" (
        "id"                      BIGSERIAL PRIMARY KEY,
        "invoice_id"              UUID NOT NULL REFERENCES "invoices"("id") ON DELETE CASCADE,
        "product_id"              UUID NOT NULL REFERENCES "item_cart"("id") ON DELETE RESTRICT,
        "quantity"                NUMERIC(14,3) NOT NULL,
        "unit_price"              INTEGER NOT NULL,
        "unit_of_measure"         TEXT NOT NULL DEFAULT 'PCE',
        "tax_type"                TEXT NOT NULL,
        "tax_category"            TEXT NOT NULL,
        "tax_rate"                NUMERIC(5,4) NOT NULL,
        "subtotal"                INTEGER NOT NULL,
        "line_discount_type"      TEXT NOT NULL DEFAULT 'PERCENTAGE',
        "line_discount_value"     NUMERIC(14,3) NOT NULL DEFAULT 0,
        "line_discount_amount"    INTEGER NOT NULL DEFAULT 0,
        "net_after_line_discount" INTEGER NOT NULL,
        "taxable_base"            INTEGER NOT NULL,
        "tax_amount"              INTEGER NOT NULL,
        "line_total"              INTEGER NOT NULL,
        CONSTRAINT "ck_invoice_lines_tax_type" CHECK ("tax_type" IN ('TAXABLE','INCLUSIVE','EXEMPT')),
        CONSTRAINT "ck_invoice_lines_tax_category" CHECK ("tax_category" IN ('S','Z','E')),
        CONSTRAINT "ck_invoice_lines_discount_type" CHECK ("line_discount_type" IN ('PERCENTAGE','FIXED_AMOUNT'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_invoice_lines_invoice" ON "invoice_lines" ("invoice_id")`);
    await queryRunner.query(`CREATE INDEX "idx_invoice_lines_product" ON "invoice_lines" ("product_id")`);

    await queryRunner.query(`
      CREATE TABLE "invoice_approvals" (
        "id"         BIGSERIAL PRIMARY KEY,
        "invoice_id" UUID NOT NULL REFERENCES "invoices"("id") ON DELETE CASCADE,
        "action"     TEXT NOT NULL,
        "actor_id"   UUID REFERENCES "users"("id") ON DELETE SET NULL,
        "reason"     TEXT,
        "acted_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "ck_invoice_approvals_action"
          CHECK ("action" IN ('submitted','approved','rejected','override'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_invoice_approvals_invoice_acted" ON "invoice_approvals" ("invoice_id", "acted_at" DESC)
    `);

    // bridge to legacy GL voucher
    await queryRunner.query(`
      ALTER TABLE "voucher_headers"
        ADD COLUMN "invoice_id" UUID REFERENCES "invoices"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "voucher_headers" DROP COLUMN IF EXISTS "invoice_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invoice_approvals"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invoice_lines"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invoices"`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "invoice_number_seq"`);
  }
}
