import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plan 11 — Jordan Tax & JoFotara.
 *
 *  - `credit_notes` + `credit_note_lines`: returns (ISTD type 381).
 *  - `tax_ledger_entries`: append-only ledger for monthly ISTD filing.
 *  - `jofotara_submission_log`: every ISTD HTTP attempt (debug + dispute).
 *  - `invoice_line_returnable_qty` view: original qty minus already-returned.
 *
 * Single-tenant — no tenant_id / RLS. Money in INTEGER fils.
 */
export class AddCreditNotesTaxLedgerJoFotara1716600000000 implements MigrationInterface {
  name = 'AddCreditNotesTaxLedgerJoFotara1716600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS "credit_note_number_seq" START 1`);

    await queryRunner.query(`
      CREATE TABLE "credit_notes" (
        "id"                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "credit_note_number"           TEXT NOT NULL,
        "original_invoice_id"          UUID NOT NULL REFERENCES "invoices"("id") ON DELETE RESTRICT,
        "rep_id"                       UUID NOT NULL REFERENCES "reps"("id") ON DELETE RESTRICT,
        "customer_id"                  UUID NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
        "reason"                       TEXT NOT NULL,
        "subtotal"                     INTEGER NOT NULL DEFAULT 0,
        "total_line_discounts"         INTEGER NOT NULL DEFAULT 0,
        "net_after_line_discounts"     INTEGER NOT NULL DEFAULT 0,
        "total_return_tax"             INTEGER NOT NULL DEFAULT 0,
        "grand_return_total"           INTEGER NOT NULL DEFAULT 0,
        "invoice_type_code"            TEXT NOT NULL DEFAULT '381',
        "jofotara_uuid"                UUID,
        "jofotara_status"              TEXT NOT NULL DEFAULT 'PENDING',
        "jofotara_qr_code"             TEXT,
        "jofotara_registration_number" TEXT,
        "jofotara_error_code"          TEXT,
        "jofotara_error_message"       TEXT,
        "jofotara_submitted_at"        TIMESTAMPTZ,
        "issued_at"                    TIMESTAMPTZ NOT NULL DEFAULT now(),
        "created_at"                   TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"                   TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"                   TIMESTAMPTZ,
        CONSTRAINT "uq_credit_notes_number" UNIQUE ("credit_note_number"),
        CONSTRAINT "ck_credit_notes_jofotara_status"
          CHECK ("jofotara_status" IN ('PENDING','SUBMITTED','VALIDATED','REJECTED','ERROR'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_credit_notes_original" ON "credit_notes" ("original_invoice_id")`);
    await queryRunner.query(`CREATE INDEX "idx_credit_notes_jofotara" ON "credit_notes" ("jofotara_status", "jofotara_submitted_at")`);

    await queryRunner.query(`
      CREATE TABLE "credit_note_lines" (
        "id"                      BIGSERIAL PRIMARY KEY,
        "credit_note_id"          UUID NOT NULL REFERENCES "credit_notes"("id") ON DELETE CASCADE,
        "invoice_line_id"         BIGINT REFERENCES "invoice_lines"("id") ON DELETE SET NULL,
        "product_id"              UUID NOT NULL REFERENCES "item_cart"("id") ON DELETE RESTRICT,
        "quantity"                NUMERIC(14,3) NOT NULL,
        "unit_price"              INTEGER NOT NULL,
        "unit_of_measure"         TEXT NOT NULL DEFAULT 'PCE',
        "tax_type"                TEXT NOT NULL,
        "tax_category"            TEXT NOT NULL,
        "tax_rate"                NUMERIC(5,4) NOT NULL,
        "subtotal"                INTEGER NOT NULL,
        "line_discount_amount"    INTEGER NOT NULL DEFAULT 0,
        "net_after_line_discount" INTEGER NOT NULL,
        "taxable_base"            INTEGER NOT NULL,
        "tax_amount"              INTEGER NOT NULL,
        "line_total"              INTEGER NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_cnl_credit_note" ON "credit_note_lines" ("credit_note_id")`);
    await queryRunner.query(`CREATE INDEX "idx_cnl_invoice_line" ON "credit_note_lines" ("invoice_line_id")`);

    await queryRunner.query(`
      CREATE TABLE "tax_ledger_entries" (
        "id"                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "entry_type"                TEXT NOT NULL,
        "document_kind"             TEXT NOT NULL,
        "document_id"               UUID NOT NULL,
        "document_number"           TEXT NOT NULL,
        "reference_document_number" TEXT,
        "entry_date"                DATE NOT NULL,
        "buyer_name"                TEXT,
        "buyer_tin"                 TEXT,
        "taxable_amount"            INTEGER NOT NULL,
        "tax_amount"                INTEGER NOT NULL,
        "grand_total"               INTEGER NOT NULL,
        "jofotara_status"           TEXT NOT NULL,
        "qr_code"                   TEXT,
        "created_at"                TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "ck_tle_entry_type" CHECK ("entry_type" IN ('SALE','RETURN')),
        CONSTRAINT "ck_tle_doc_kind" CHECK ("document_kind" IN ('INVOICE','CREDIT_NOTE'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_tle_date_status" ON "tax_ledger_entries" ("entry_date", "jofotara_status")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_tle_document" ON "tax_ledger_entries" ("document_kind", "document_id")`);

    await queryRunner.query(`
      CREATE TABLE "jofotara_submission_log" (
        "id"               BIGSERIAL PRIMARY KEY,
        "document_kind"    TEXT NOT NULL,
        "document_id"      UUID NOT NULL,
        "attempt"          INTEGER NOT NULL,
        "request_url"      TEXT,
        "request_payload"  JSONB,
        "response_status"  INTEGER,
        "response_body"    JSONB,
        "duration_ms"      INTEGER,
        "error"            TEXT,
        "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_jsl_document" ON "jofotara_submission_log" ("document_id", "attempt")`);

    await queryRunner.query(`
      CREATE VIEW "invoice_line_returnable_qty" AS
      SELECT il.id AS invoice_line_id,
             il.quantity - COALESCE(SUM(cnl.quantity), 0) AS returnable_qty
      FROM invoice_lines il
      LEFT JOIN credit_note_lines cnl ON cnl.invoice_line_id = il.id
      GROUP BY il.id, il.quantity
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP VIEW IF EXISTS "invoice_line_returnable_qty"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "jofotara_submission_log"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tax_ledger_entries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "credit_note_lines"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "credit_notes"`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "credit_note_number_seq"`);
  }
}
