import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Delivery & collection representative — phase 1 (docs/SPEC-delivery-rep.md §4.1).
 *
 * reps.kind — SALES | DELIVERY | BOTH. Every existing rep stays SALES, so
 *   nothing changes until an admin picks a role.
 *
 * delivery_runs / delivery_stops / delivery_stop_lines — a READ MIRROR of the
 *   ERP's delivery runs (R1: the ERP owns the run). CashVan writes them only
 *   from the ERP pull, and from its own in-flight phone results (the local_*
 *   columns on the stop). Money is fils, like every amount in this database.
 *   delivery_proofs is phase 2 and is not created here.
 *
 * collections.erp_invoice_number — the ERP invoice a collection was taken
 *   against; the PAYMENT push sends it as `invoiceNumber`.
 *
 * app_settings.delivery_increase_requests / delivery_proof_required — the two
 *   company switches served in company-info.
 *
 * erp_outbox.kind and voucher_inbox.type carry no CHECK constraint, so the new
 * DELIVERY_RESULT outbox kind and DELIVERY inbox type need no DDL.
 */
export class DeliveryRep1728610000000 implements MigrationInterface {
  name = 'DeliveryRep1728610000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── reps.kind ──────────────────────────────────────────────────────────
    await q.query(`ALTER TABLE "reps" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'SALES'`);
    await q.query(`ALTER TABLE "reps" DROP CONSTRAINT IF EXISTS "chk_reps_kind"`);
    await q.query(
      `ALTER TABLE "reps" ADD CONSTRAINT "chk_reps_kind" CHECK ("kind" IN ('SALES','DELIVERY','BOTH'))`,
    );

    // ── delivery_runs ──────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "delivery_runs" (
        "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "erp_id"         text NOT NULL,
        "run_number"     text,
        "rep_id"         uuid REFERENCES "reps"("id") ON DELETE SET NULL,
        "driver_code"    text,
        "driver_name"    text,
        "vehicle_erp_id" text,
        "vehicle_name"   text,
        "vehicle_plate"  text,
        "run_date"       date,
        "status"         text NOT NULL DEFAULT 'OPEN',
        "notes"          text,
        "opened_at"      timestamptz,
        "closed_at"      timestamptz,
        "erp_updated_at" timestamptz,
        "synced_at"      timestamptz,
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        "updated_at"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_delivery_runs_status" CHECK ("status" IN ('OPEN','CLOSED'))
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_delivery_runs_erp_id" ON "delivery_runs" ("erp_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_delivery_runs_rep_status" ON "delivery_runs" ("rep_id", "status")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_delivery_runs_date" ON "delivery_runs" ("run_date")`,
    );

    // ── delivery_stops ─────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "delivery_stops" (
        "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "erp_id"                 text NOT NULL,
        "run_id"                 uuid NOT NULL REFERENCES "delivery_runs"("id") ON DELETE CASCADE,
        "sequence"               integer NOT NULL DEFAULT 0,
        "erp_invoice_id"         text,
        "invoice_number"         text,
        "invoice_date"           timestamptz,
        "customer_id"            uuid REFERENCES "customers"("id") ON DELETE SET NULL,
        "erp_customer_id"        text,
        "customer_code"          text,
        "recipient_name"         text,
        "recipient_phone"        text,
        "address"                text,
        "total_fils"             bigint NOT NULL DEFAULT 0,
        "tax_fils"               bigint NOT NULL DEFAULT 0,
        "paid_fils"              bigint NOT NULL DEFAULT 0,
        "payment_type"           text,
        "jofotara_status"        text,
        "jofotara_qr"            text,
        "jofotara_uuid"          text,
        "status"                 text NOT NULL DEFAULT 'LOADED',
        "delivered_at"           timestamptz,
        "signed_by_name"         text,
        "lat"                    numeric,
        "lng"                    numeric,
        "result_source"          text,
        "result_external_ref"    text,
        "return_status"          text NOT NULL DEFAULT 'NONE',
        "return_decision_note"   text,
        "credit_note_number"     text,
        "credit_note_qr"         text,
        "credit_note_total_fils" bigint,
        "local_result_ref"       text,
        "local_outcome"          text,
        "local_delivered_at"     timestamptz,
        "local_signed_by"        text,
        "local_lat"              numeric,
        "local_lng"              numeric,
        "local_note"             text,
        "created_at"             timestamptz NOT NULL DEFAULT now(),
        "updated_at"             timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_delivery_stops_status"
          CHECK ("status" IN ('LOADED','DELIVERED','PARTIAL','RETURNED')),
        CONSTRAINT "chk_delivery_stops_return_status"
          CHECK ("return_status" IN ('NONE','PENDING','APPROVED','REJECTED')),
        CONSTRAINT "chk_delivery_stops_local_outcome"
          CHECK ("local_outcome" IS NULL OR "local_outcome" IN ('DELIVERED','PARTIAL','RETURNED'))
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_delivery_stops_erp_id" ON "delivery_stops" ("erp_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_delivery_stops_run" ON "delivery_stops" ("run_id", "sequence")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_delivery_stops_invoice" ON "delivery_stops" ("invoice_number")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_delivery_stops_erp_invoice" ON "delivery_stops" ("erp_invoice_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_delivery_stops_customer" ON "delivery_stops" ("customer_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_delivery_stops_local_ref" ON "delivery_stops" ("local_result_ref")
         WHERE "local_result_ref" IS NOT NULL`,
    );

    // ── delivery_stop_lines ────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "delivery_stop_lines" (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "stop_id"             uuid NOT NULL REFERENCES "delivery_stops"("id") ON DELETE CASCADE,
        "erp_invoice_item_id" text NOT NULL,
        "line_no"             integer,
        "sku_code"            text,
        "name_ar"             text,
        "name_en"             text,
        "unit"                text,
        "invoiced_qty"        numeric NOT NULL DEFAULT 0,
        "unit_price_fils"     bigint NOT NULL DEFAULT 0,
        "tax_rate"            numeric,
        "delivered_qty"       numeric,
        "reason_code"         text,
        "note"                text,
        "condition"           text,
        "approved_qty"        numeric,
        "created_at"          timestamptz NOT NULL DEFAULT now(),
        "updated_at"          timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_delivery_stop_lines_item"
         ON "delivery_stop_lines" ("stop_id", "erp_invoice_item_id")`,
    );

    // ── collections.erp_invoice_number ─────────────────────────────────────
    await q.query(`ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "erp_invoice_number" text`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_collections_erp_invoice_number" ON "collections" ("erp_invoice_number")
         WHERE "erp_invoice_number" IS NOT NULL`,
    );

    // ── company switches ───────────────────────────────────────────────────
    await q.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "delivery_increase_requests" boolean NOT NULL DEFAULT false`,
    );
    await q.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "delivery_proof_required" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "delivery_proof_required"`);
    await q.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "delivery_increase_requests"`);
    await q.query(`DROP INDEX IF EXISTS "idx_collections_erp_invoice_number"`);
    await q.query(`ALTER TABLE "collections" DROP COLUMN IF EXISTS "erp_invoice_number"`);
    await q.query(`DROP TABLE IF EXISTS "delivery_stop_lines"`);
    await q.query(`DROP TABLE IF EXISTS "delivery_stops"`);
    await q.query(`DROP TABLE IF EXISTS "delivery_runs"`);
    await q.query(`ALTER TABLE "reps" DROP CONSTRAINT IF EXISTS "chk_reps_kind"`);
    await q.query(`ALTER TABLE "reps" DROP COLUMN IF EXISTS "kind"`);
  }
}
