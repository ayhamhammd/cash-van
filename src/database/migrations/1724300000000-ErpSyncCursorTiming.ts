import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-entity timing + skip count on the ERP sync cursor.
 *
 * Without a duration there is no way to answer "which step is making the sweep
 * take three minutes" from the dashboard — the only evidence was the gap between
 * two rows' `last_run_at`, which is unreadable once entities run out of order or
 * on their own from the per-row button.
 *
 * `last_skipped` is the companion to making the item pull skip-and-continue: a
 * run that mirrored 900 products and skipped 3 on a duplicate barcode must not
 * look identical to one that mirrored 903.
 */
export class ErpSyncCursorTiming1724300000000 implements MigrationInterface {
  name = 'ErpSyncCursorTiming1724300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "erp_sync_cursor" ADD COLUMN IF NOT EXISTS "duration_ms" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "erp_sync_cursor" ADD COLUMN IF NOT EXISTS "last_skipped" integer NOT NULL DEFAULT 0`,
    );
    // A process that died mid-sweep leaves rows stuck on 'running' forever;
    // nothing clears them on boot, so settle them once here.
    await queryRunner.query(
      `UPDATE "erp_sync_cursor" SET "last_status" = 'failed',
         "last_error" = COALESCE("last_error", 'interrupted — the server restarted mid-sync')
       WHERE "last_status" = 'running'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "erp_sync_cursor" DROP COLUMN IF EXISTS "last_skipped"`,
    );
    await queryRunner.query(
      `ALTER TABLE "erp_sync_cursor" DROP COLUMN IF EXISTS "duration_ms"`,
    );
  }
}
