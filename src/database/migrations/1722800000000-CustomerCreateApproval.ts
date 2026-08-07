import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Salesman-created customers: a document photo, and admin approval by default.
 *
 * `can_add_customer` already decides whether a rep may create a customer at all.
 * This adds the second question — may they create one that is immediately REAL?
 *
 *   can_add_customer = false                          cannot create
 *   + can_create_customer_direct = false  (default)   creates an approval request
 *   + can_create_customer_direct = true               creates the customer outright
 *
 * The default is false on purpose: a customer record is a credit relationship,
 * and the safe default for a new rep is that someone in the office looks first.
 * Existing reps are unaffected in practice — before this migration nobody could
 * create anything without `can_add_customer`, and those who have it are named
 * individuals the admin can flip on deliberately.
 */
export class CustomerCreateApproval1722800000000 implements MigrationInterface {
  name = 'CustomerCreateApproval1722800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "users"
        ADD COLUMN "can_create_customer_direct" boolean NOT NULL DEFAULT false`);

    // The approval request carries the whole pending customer (including the
    // photo) in its existing jsonb payload, so no new table is needed — but the
    // photo is bytes, and bytes do not belong in a jsonb column that is read on
    // every approvals list. It is staged in the object store and referenced here.
    await q.query(`
      CREATE TABLE "pending_customer_photos" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "storage_key"   text NOT NULL,
        "url"           text NOT NULL,
        "original_name" text NOT NULL,
        "mime_type"     text NOT NULL,
        "size_bytes"    integer NOT NULL DEFAULT 0,
        "uploaded_by"   uuid,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "claimed_at"    timestamptz
      )`);

    // Unclaimed rows are rubbish to sweep: a rep who photographed a shop and then
    // abandoned the form. `claimed_at IS NULL` is the whole query.
    await q.query(`
      CREATE INDEX "idx_pending_customer_photos_unclaimed"
        ON "pending_customer_photos" ("created_at") WHERE "claimed_at" IS NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_pending_customer_photos_unclaimed"`);
    await q.query(`DROP TABLE IF EXISTS "pending_customer_photos"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN "can_create_customer_direct"`);
  }
}
