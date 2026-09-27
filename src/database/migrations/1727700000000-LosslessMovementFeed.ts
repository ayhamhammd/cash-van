import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The ERP stock-movement feed stops losing movements.
 *
 * seq_cursor: the feed was read by `createdAt`. Postgres stamps `now()` at the
 * START of a transaction, so an ERP invoice that took a second to post carried a
 * timestamp older than a movement committed after it — and once the hub had read
 * that later one, `createdAt > cursor` skipped the invoice for good. The ERP has
 * offered a monotonic `seq` cursor since f8cf4ec; this is where the hub keeps it.
 * NULL means "not switched over yet": the next run reads by the old timestamp one
 * last time and records the seq it saw.
 *
 * erp_movement_retry: a movement that could not be mirrored — nearly always a SKU
 * the catalogue has not synced yet — was logged and stepped over, and the cursor
 * moved on without it. It was never seen again. It now waits here and is retried
 * every run until it lands.
 */
export class LosslessMovementFeed1727700000000 implements MigrationInterface {
  name = 'LosslessMovementFeed1727700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "erp_sync_cursor" ADD COLUMN IF NOT EXISTS "seq_cursor" bigint`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "erp_movement_retry" (
        "erp_id"          text PRIMARY KEY,
        "store"           text NOT NULL,
        "payload"         jsonb NOT NULL,
        "attempts"        integer NOT NULL DEFAULT 1,
        "last_error"      text,
        "first_failed_at" timestamptz NOT NULL DEFAULT now(),
        "last_tried_at"   timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_erp_movement_retry_store" ON "erp_movement_retry" ("store")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "erp_movement_retry"`);
    await q.query(`ALTER TABLE "erp_sync_cursor" DROP COLUMN IF EXISTS "seq_cursor"`);
  }
}
