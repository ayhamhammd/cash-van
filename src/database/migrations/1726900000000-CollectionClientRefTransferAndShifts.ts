import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Three gaps the handset cannot work around, because the API refuses any body
 * carrying a property it has not declared.
 *
 * 1. `client_ref` on collections. A request that commits and then times out is
 *    re-sent, and the customer is credited twice — real money, roughly as often
 *    as a van loses coverage mid-post. The voucher path has had idempotency for
 *    a long time; collections never got it. UNIQUE, because dedupe that depends
 *    on a SELECT racing an INSERT is not dedupe.
 *
 * 2. `transfer` as a payment method, with its own reference. The enum allowed
 *    cash and cheque only, so the app downgraded every bank transfer to cash
 *    and threw the reference away — while asking the rep for it. The ERP then
 *    had nothing to reconcile against the bank statement. The reference gets
 *    its own column rather than living in `note`: `note` is free text a rep
 *    types, and this is the key an accountant matches on.
 *
 * 3. `shifts`. A rep's working day never left the handset. Open and close carry
 *    their own coordinates and their own timestamps, because a shift that syncs
 *    after an outage must not be stamped with the hour it arrived.
 *
 * The method column is text with no CHECK, so widening it needs no DDL — only
 * the DTO changes. Recorded here so the change is not invisible in the history.
 */
export class CollectionClientRefTransferAndShifts1726900000000 implements MigrationInterface {
  name = 'CollectionClientRefTransferAndShifts1726900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "client_ref" text`);
    // Partial: every pre-existing row is NULL, and NULLs do not collide in a
    // unique index — so this applies to new traffic without a backfill.
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_collections_client_ref"
         ON "collections" ("client_ref") WHERE "client_ref" IS NOT NULL`,
    );
    await q.query(`ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "transfer_ref" text`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "shifts" (
        "id"           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "rep_id"       uuid NOT NULL,
        "client_ref"   text,
        "opened_at"    timestamptz NOT NULL,
        "closed_at"    timestamptz,
        "open_lat"     double precision,
        "open_lng"     double precision,
        "close_lat"    double precision,
        "close_lng"    double precision,
        "note"         text,
        "created_at"   timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_shifts_client_ref"
         ON "shifts" ("client_ref") WHERE "client_ref" IS NOT NULL`,
    );
    // The question this table is asked most: "is this rep open right now", and
    // "what did they do last week".
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_shifts_rep_opened" ON "shifts" ("rep_id", "opened_at" DESC)`,
    );
    // One open shift per rep. A second open is the same day counted twice.
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_shifts_one_open_per_rep"
         ON "shifts" ("rep_id") WHERE "closed_at" IS NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "shifts"`);
    await q.query(`DROP INDEX IF EXISTS "uq_collections_client_ref"`);
    await q.query(`ALTER TABLE "collections" DROP COLUMN IF EXISTS "transfer_ref"`);
    await q.query(`ALTER TABLE "collections" DROP COLUMN IF EXISTS "client_ref"`);
  }
}
