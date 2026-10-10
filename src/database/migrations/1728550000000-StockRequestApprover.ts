import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Who approved a stock request, kept apart from whoever decided it last.
 *
 * An approved request that has not been received can now be rejected. Until
 * then reviewer_user / decided_at were the only record of the approval, and the
 * rejection would overwrite them — the report of who granted what would lose
 * exactly the approvals that were later taken back.
 *
 * Backfilled from reviewer_user / decided_at for every request that is approved
 * or received today: for those, the last decision IS the approval.
 */
export class StockRequestApprover1728550000000 implements MigrationInterface {
  name = 'StockRequestApprover1728550000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE stock_requests
        ADD COLUMN IF NOT EXISTS approved_by uuid NULL,
        ADD COLUMN IF NOT EXISTS approved_at timestamptz NULL
    `);
    await queryRunner.query(`
      UPDATE stock_requests
         SET approved_by = reviewer_user,
             approved_at = decided_at
       WHERE status IN ('approved', 'received')
         AND approved_by IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE stock_requests
        DROP COLUMN IF EXISTS approved_by,
        DROP COLUMN IF EXISTS approved_at
    `);
  }
}
