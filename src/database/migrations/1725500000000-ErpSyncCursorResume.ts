import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where a bounded entity stopped, so the next run picks up instead of restarting.
 *
 * customer_price asks the ERP to resolve every SKU for every customer, one HTTP
 * round trip per page per customer. At a few thousand customers that is tens of
 * thousands of calls: the run never reached the end, so it never wrote a cursor,
 * so the next run began again at the first customer and no later customer was
 * ever synced. It showed as "running" for ever with a count of 0.
 */
export class ErpSyncCursorResume1725500000000 implements MigrationInterface {
  name = 'ErpSyncCursorResume1725500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "erp_sync_cursor" ADD COLUMN IF NOT EXISTS "resume_key" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "erp_sync_cursor" DROP COLUMN IF EXISTS "resume_key"`,
    );
  }
}
