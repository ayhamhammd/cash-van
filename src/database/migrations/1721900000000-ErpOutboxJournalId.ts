import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record the ERP's GL posting outcome alongside each pushed document.
 *
 * The ERP now isolates journal posting in a savepoint: a sales invoice whose
 * org has no payment-method account mapped still returns 201 with the invoice,
 * its lines, the payment row and the stock movements all committed — only the
 * journal is skipped, and `journalId` comes back null. Without these columns a
 * misconfigured org produces van sales that look perfectly synced here while
 * posting nothing to the general ledger, and nobody finds out until close.
 *
 * The partial index backs the one question ops actually asks — "which posted
 * sales never reached the GL?" — and stays tiny because the healthy case is
 * excluded from it entirely.
 */
export class ErpOutboxJournalId1721900000000 implements MigrationInterface {
  name = 'ErpOutboxJournalId1721900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "erp_outbox"
        ADD COLUMN IF NOT EXISTS "journal_id" text,
        ADD COLUMN IF NOT EXISTS "payment_skipped" boolean NOT NULL DEFAULT false
    `);
    // CAVEAT: rows pushed BEFORE this deploy also have journal_id NULL, simply
    // because the field wasn't captured then — they are indistinguishable from
    // genuinely unposted ones. The index is on created_at precisely so the ops
    // query can bound itself to the deploy date and skip that ambiguous tail.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_erp_outbox_unposted_journal"
        ON "erp_outbox" ("created_at")
        WHERE "kind" = 'SALE_INVOICE'
          AND "status" = 'posted'
          AND "journal_id" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_erp_outbox_unposted_journal"`);
    await queryRunner.query(`
      ALTER TABLE "erp_outbox"
        DROP COLUMN IF EXISTS "payment_skipped",
        DROP COLUMN IF EXISTS "journal_id"
    `);
  }
}
