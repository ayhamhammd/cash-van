import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Soft delete for stock requests, and the link to the transfer that fulfilled one.
 *
 * `transfer_voucher_number` already existed but was only ever written by the van
 * confirming receipt. The office can now raise that transfer itself from an
 * approved request, so the column needs to be reachable from both sides — and
 * whichever writes it first closes the request, because a second transfer would
 * move the same goods twice.
 */
export class StockRequestSoftDelete1723300000000 implements MigrationInterface {
  name = 'StockRequestSoftDelete1723300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "stock_requests" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz`,
    );
    // Partial index: the queue only ever reads rows that are NOT deleted, so the
    // index that serves it should not carry the ones it always filters out.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_stock_requests_live"
         ON "stock_requests" ("status", "created_at") WHERE "deleted_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_stock_requests_live"`);
    await queryRunner.query(`ALTER TABLE "stock_requests" DROP COLUMN IF EXISTS "deleted_at"`);
  }
}
