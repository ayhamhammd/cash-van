import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Delivery rep — phase 4: increase requests (delivery phase-4 contract §B,
 * docs/SPEC-delivery-rep.md §3.2).
 *
 * At a stop the customer asks for more than the invoice. The rep never adds to
 * the issued invoice (R2) and never sells from the truck (Q1); the phone
 * records a request, which travels with the stop's result. The office then
 * either turns it into a normal ORDER voucher (through the vouchers service,
 * so it reaches the ERP as a sales order like any other) or dismisses it.
 *
 * client_ref is the RESULT's clientRef: one request per result, and a replayed
 * result cannot make a second one. decision_key is the dashboard's
 * Idempotency-Key for the decision, so a replayed click answers the same
 * decision instead of making a second order.
 */
export class DeliveryIncreaseRequests1728700000000 implements MigrationInterface {
  name = 'DeliveryIncreaseRequests1728700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "delivery_increase_requests" (
        "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "client_ref"           text NOT NULL,
        "stop_id"              uuid REFERENCES "delivery_stops"("id") ON DELETE SET NULL,
        "run_id"               uuid REFERENCES "delivery_runs"("id") ON DELETE SET NULL,
        "customer_id"          uuid REFERENCES "customers"("id") ON DELETE SET NULL,
        "rep_id"               uuid REFERENCES "reps"("id") ON DELETE SET NULL,
        "invoice_number"       text,
        "lines"                jsonb NOT NULL,
        "status"               text NOT NULL DEFAULT 'PENDING',
        "order_voucher_id"     uuid,
        "order_voucher_number" text,
        "order_total_fils"     bigint,
        "decided_by"           text,
        "decided_at"           timestamptz,
        "decision_note"        text,
        "decision_key"         text,
        "created_at"           timestamptz NOT NULL DEFAULT now(),
        "updated_at"           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_delivery_increase_requests_status"
          CHECK ("status" IN ('PENDING','ORDERED','DISMISSED'))
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_delivery_increase_requests_client_ref"
         ON "delivery_increase_requests" ("client_ref")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_delivery_increase_requests_pending"
         ON "delivery_increase_requests" ("status") WHERE "status" = 'PENDING'`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_delivery_increase_requests_stop"
         ON "delivery_increase_requests" ("stop_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "delivery_increase_requests"`);
  }
}
