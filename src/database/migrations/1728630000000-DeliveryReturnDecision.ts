import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Delivery rep — phase 3: return approval and the credit note (delivery
 * phase-3 contract §B).
 *
 * delivery_stops — the ERP's decision on a stop's return and the credit note
 *   it issued. return_status, return_decision_note, credit_note_number,
 *   credit_note_qr and credit_note_total_fils exist since 1728610000000; this
 *   adds who decided and when, and the rest of the credit note.
 *
 * delivery_stop_lines — billed_qty and line_total_fils, so a return is valued
 *   at the invoice's own prices: line_total (tax included) × qty / billed. The
 *   approved quantity lands in approved_qty, which already exists.
 */
export class DeliveryReturnDecision1728630000000 implements MigrationInterface {
  name = 'DeliveryReturnDecision1728630000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "delivery_stops"
        ADD COLUMN IF NOT EXISTS "return_decided_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "return_decided_by" text,
        ADD COLUMN IF NOT EXISTS "credit_note_erp_id" text,
        ADD COLUMN IF NOT EXISTS "credit_note_tax_fils" bigint,
        ADD COLUMN IF NOT EXISTS "credit_note_jofotara_status" text,
        ADD COLUMN IF NOT EXISTS "credit_note_uuid" text`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_delivery_stops_return_status" ON "delivery_stops" ("return_status")
         WHERE "return_status" <> 'NONE'`,
    );
    await q.query(`
      ALTER TABLE "delivery_stop_lines"
        ADD COLUMN IF NOT EXISTS "billed_qty" numeric,
        ADD COLUMN IF NOT EXISTS "line_total_fils" bigint NOT NULL DEFAULT 0`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "delivery_stop_lines"
        DROP COLUMN IF EXISTS "line_total_fils",
        DROP COLUMN IF EXISTS "billed_qty"`);
    await q.query(`DROP INDEX IF EXISTS "idx_delivery_stops_return_status"`);
    await q.query(`
      ALTER TABLE "delivery_stops"
        DROP COLUMN IF EXISTS "credit_note_uuid",
        DROP COLUMN IF EXISTS "credit_note_jofotara_status",
        DROP COLUMN IF EXISTS "credit_note_tax_fils",
        DROP COLUMN IF EXISTS "credit_note_erp_id",
        DROP COLUMN IF EXISTS "return_decided_by",
        DROP COLUMN IF EXISTS "return_decided_at"`);
  }
}
