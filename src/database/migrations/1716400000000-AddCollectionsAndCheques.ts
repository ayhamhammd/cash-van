import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plan 07 — Cash & Cheque Collections.
 *
 *  - `collections`: rep-facing cash/cheque collections (fils), with a
 *    pending → confirmed → deposited/bounced lifecycle. Bridged to the legacy
 *    GL `payments` table via nullable `payment_id`.
 *  - `cheques`: collection-bound cheque detail with OCR metadata, words-match
 *    flag, and self-contained reconciliation (`reconciled_at` / `reconciled_by`).
 *    Bridged to legacy `payment_cheques` via nullable `payment_cheque_id`.
 *
 * Single-tenant — no tenant_id / RLS. Money in INTEGER fils.
 */
export class AddCollectionsAndCheques1716400000000 implements MigrationInterface {
  name = 'AddCollectionsAndCheques1716400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "collections" (
        "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "rep_id"       UUID NOT NULL REFERENCES "reps"("id") ON DELETE RESTRICT,
        "customer_id"  UUID NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
        "invoice_id"   UUID REFERENCES "invoices"("id") ON DELETE SET NULL,
        "payment_id"   UUID REFERENCES "payments"("id") ON DELETE SET NULL,
        "amount"       INTEGER NOT NULL,
        "method"       TEXT NOT NULL,
        "status"       TEXT NOT NULL DEFAULT 'pending',
        "collected_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "confirmed_at" TIMESTAMPTZ,
        "deposited_at" TIMESTAMPTZ,
        "note"         TEXT,
        "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "ck_collections_method" CHECK ("method" IN ('cash','cheque')),
        CONSTRAINT "ck_collections_status" CHECK ("status" IN ('pending','confirmed','deposited','bounced')),
        CONSTRAINT "ck_collections_amount" CHECK ("amount" > 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_collections_rep_collected" ON "collections" ("rep_id", "collected_at" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_collections_status_collected" ON "collections" ("status", "collected_at" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_collections_customer_status" ON "collections" ("customer_id", "status")`);
    await queryRunner.query(`CREATE INDEX "idx_collections_invoice" ON "collections" ("invoice_id") WHERE "invoice_id" IS NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE "cheques" (
        "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "collection_id"     UUID NOT NULL REFERENCES "collections"("id") ON DELETE CASCADE,
        "bank_name"         TEXT,
        "cheque_number"     TEXT,
        "payee"             TEXT,
        "amount"            INTEGER NOT NULL,
        "amount_words"      TEXT,
        "due_date"          DATE,
        "ocr_confidence"    REAL,
        "words_match"       BOOLEAN NOT NULL DEFAULT TRUE,
        "scan_source"       TEXT NOT NULL DEFAULT 'server',
        "status"            TEXT NOT NULL DEFAULT 'pending',
        "image_path"        TEXT,
        "scanned_at"        TIMESTAMPTZ,
        "reconciled_at"     TIMESTAMPTZ,
        "reconciled_by"     UUID REFERENCES "users"("id") ON DELETE SET NULL,
        "payment_cheque_id" UUID REFERENCES "payment_cheques"("id") ON DELETE SET NULL,
        "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "ck_cheques_scan_source" CHECK ("scan_source" IN ('server','mlkit_offline')),
        CONSTRAINT "ck_cheques_status" CHECK ("status" IN ('pending','cleared','bounced','cancelled')),
        CONSTRAINT "ck_cheques_amount" CHECK ("amount" > 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_cheques_collection" ON "cheques" ("collection_id")`);
    await queryRunner.query(`CREATE INDEX "idx_cheques_due_date" ON "cheques" ("due_date")`);
    await queryRunner.query(`CREATE INDEX "idx_cheques_status" ON "cheques" ("status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cheques"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "collections"`);
  }
}
