import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Let the ERP queue be written inside the voucher's own transaction.
 *
 * `enqueue` was a check-then-insert — `findOne` by (kind, ref), then `save` —
 * against a table with only a NON-unique index on `ref`. Two concurrent
 * enqueues for one document made two rows that then disagreed about `status`,
 * `journal_id` and `payment_skipped`, which is what the dashboard and the
 * reconciliation report read. The ERP's own Idempotency-Key meant no duplicate
 * invoice was ever created, so this has been harmless in practice and invisible
 * in consequence.
 *
 * The unique constraint is what lets the enqueue become a single
 * `INSERT ... ON CONFLICT` statement, which is what lets it live inside a
 * transaction it does not own.
 */
export class TransactionalOutbox1727200000000 implements MigrationInterface {
  name = 'TransactionalOutbox1727200000000';

  public async up(q: QueryRunner): Promise<void> {
    // Collapse duplicates before constraining. Keep the most informative row:
    // posted beats pending beats failed beats dead_letter; newest breaks ties.
    await q.query(`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY kind, ref
                 ORDER BY CASE status
                            WHEN 'posted' THEN 0
                            WHEN 'pending' THEN 1
                            WHEN 'failed' THEN 2
                            ELSE 3 END,
                          updated_at DESC) AS rn
          FROM erp_outbox)
      DELETE FROM erp_outbox WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    `);

    await q.query(`
      ALTER TABLE "erp_outbox"
        ADD CONSTRAINT "uq_erp_outbox_kind_ref" UNIQUE ("kind", "ref")
    `);

    // The sweep's index (SPEC §4.5): posted van vouchers, by age.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "idx_voucher_headers_posted_kind_created"
        ON "voucher_headers" ("trans_kind", "created_at")
        WHERE "is_posted" = TRUE
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_voucher_headers_posted_kind_created"`);
    await q.query(
      `ALTER TABLE "erp_outbox" DROP CONSTRAINT IF EXISTS "uq_erp_outbox_kind_ref"`,
    );
  }
}
