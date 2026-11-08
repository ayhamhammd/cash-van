import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Delivery rep — phase 2: proof and line results (delivery phase-2 contract §B).
 *
 * delivery_proofs — the shipment photos and the customer's signature a delivery
 *   rep uploads before his result (docs/SPEC-delivery-rep.md §4.1). The file is
 *   kept here (StorageService, `deliveries/<stopId>/<clientRef>.<ext>`); the
 *   ERP gets a copy through the outbox (DELIVERY_PROOF) and its attachment id
 *   is written back. Idempotent on the phone's clientRef.
 *
 * delivery_stop_lines.local_* — the phone's line results while the result is
 *   in flight. Kept apart from the ERP's columns so a pull that lands before
 *   the ERP has the result cannot overwrite them with "delivered in full".
 *
 * delivery_stops.erp_only_attachments — attachments the ERP holds on the item
 *   that are not one of our proofs (uploaded in the ERP's own screen). Counted,
 *   not mirrored.
 *
 * delivery_stops.status already allows PARTIAL (1728610000000-DeliveryRep).
 */
export class DeliveryProofs1728620000000 implements MigrationInterface {
  name = 'DeliveryProofs1728620000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "delivery_proofs" (
        "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "client_ref"        text NOT NULL,
        "stop_id"           uuid NOT NULL REFERENCES "delivery_stops"("id") ON DELETE CASCADE,
        "kind"              text NOT NULL,
        "storage_key"       text NOT NULL,
        "mime"              text NOT NULL,
        "size_bytes"        integer NOT NULL,
        "captured_at"       timestamptz,
        "erp_attachment_id" text,
        "uploaded_by"       uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_delivery_proofs_kind" CHECK ("kind" IN ('PHOTO','SIGNATURE'))
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_delivery_proofs_client_ref" ON "delivery_proofs" ("client_ref")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_delivery_proofs_stop" ON "delivery_proofs" ("stop_id", "kind")`,
    );

    await q.query(`
      ALTER TABLE "delivery_stop_lines"
        ADD COLUMN IF NOT EXISTS "local_delivered_qty" numeric,
        ADD COLUMN IF NOT EXISTS "local_reason_code" text,
        ADD COLUMN IF NOT EXISTS "local_note" text`);

    await q.query(
      `ALTER TABLE "delivery_stops" ADD COLUMN IF NOT EXISTS "erp_only_attachments" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "delivery_stops" DROP COLUMN IF EXISTS "erp_only_attachments"`);
    await q.query(`
      ALTER TABLE "delivery_stop_lines"
        DROP COLUMN IF EXISTS "local_note",
        DROP COLUMN IF EXISTS "local_reason_code",
        DROP COLUMN IF EXISTS "local_delivered_qty"`);
    await q.query(`DROP TABLE IF EXISTS "delivery_proofs"`);
  }
}
