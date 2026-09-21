import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make the handset able to tell a stored document from a lost one.
 *
 * Two things this enables:
 *
 * 1. **Atomic dedupe.** The intake used to `findOne` by client_ref and then
 *    `save`. Two concurrent replays — what an offline-first client produces when
 *    a request times out on a dying link but succeeds server-side — both missed
 *    and both inserted. The partial unique index saved the database and handed
 *    the loser a raw 23505, which left the controller as a 500, which the
 *    handset read as "retry", forever. `ON CONFLICT (client_ref) DO NOTHING`
 *    needs a TOTAL unique index: a partial one only arbitrates rows matching its
 *    predicate.
 *
 * 2. **Retry state**, mirroring erp_outbox so the two queues behave alike.
 *    docs/SPEC-sync-intake-contract.md §4.3 adds the drain that consumes it.
 *
 * `client_number` keeps the number the APP minted even when the server has to
 * assign a different one, so a rep reading their handset and a clerk reading the
 * dashboard can still find each other.
 */
export class SyncIntakeContract1727150000000 implements MigrationInterface {
  name = 'SyncIntakeContract1727150000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "voucher_inbox"
        ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "client_number" text
    `);

    // 'pending' and 'failed' stay legal: installed APKs read them, and the
    // dashboard renders historical rows. New vocabulary is added alongside.
    await q.query(
      `ALTER TABLE "voucher_inbox" DROP CONSTRAINT IF EXISTS "chk_voucher_inbox_status"`,
    );
    await q.query(`
      ALTER TABLE "voucher_inbox" ADD CONSTRAINT "chk_voucher_inbox_status"
        CHECK ("status" IN ('accepted','posted','rejected','dead_letter','pending','failed'))
    `);

    // Backfill before tightening: rows predating client_ref get a synthetic one
    // derived from their id, which is unique by construction and self-labelling.
    await q.query(
      `UPDATE "voucher_inbox" SET "client_ref" = 'legacy:' || "id"::text WHERE "client_ref" IS NULL`,
    );
    await q.query(`ALTER TABLE "voucher_inbox" ALTER COLUMN "client_ref" SET NOT NULL`);
    await q.query(`DROP INDEX IF EXISTS "uq_voucher_inbox_client_ref"`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_voucher_inbox_client_ref"
        ON "voucher_inbox" ("client_ref")
    `);

    // The drain's only index. Partial, because posted rows are the overwhelming
    // majority and must never be scanned.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "idx_voucher_inbox_due"
        ON "voucher_inbox" ("next_attempt_at")
        WHERE "status" IN ('accepted','pending')
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_voucher_inbox_due"`);
    await q.query(`DROP INDEX IF EXISTS "uq_voucher_inbox_client_ref"`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_voucher_inbox_client_ref"
        ON "voucher_inbox" ("client_ref") WHERE "client_ref" IS NOT NULL
    `);
    await q.query(`ALTER TABLE "voucher_inbox" ALTER COLUMN "client_ref" DROP NOT NULL`);
    await q.query(
      `ALTER TABLE "voucher_inbox" DROP CONSTRAINT IF EXISTS "chk_voucher_inbox_status"`,
    );
    await q.query(`
      ALTER TABLE "voucher_inbox"
        DROP COLUMN IF EXISTS "client_number",
        DROP COLUMN IF EXISTS "last_attempt_at",
        DROP COLUMN IF EXISTS "next_attempt_at",
        DROP COLUMN IF EXISTS "attempts"
    `);
  }
}
