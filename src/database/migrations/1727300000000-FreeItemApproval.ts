import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Free-item approvals: a supervisor may cut a requested free quantity before
 * agreeing, and what the rep asked for must survive that edit.
 *
 * `original_payload` is kept rather than the amendment being applied in place,
 * because "the rep asked for 5" and "the supervisor allowed 1" are different facts
 * and a dispute about a giveaway needs both. Nullable throughout: every existing
 * request predates amendment and has nothing to record.
 */
export class FreeItemApproval1727300000000 implements MigrationInterface {
  name = 'FreeItemApproval1727300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE approval_requests
        ADD COLUMN IF NOT EXISTS amended_by       uuid,
        ADD COLUMN IF NOT EXISTS amended_at       timestamptz,
        ADD COLUMN IF NOT EXISTS amendment_note   text,
        ADD COLUMN IF NOT EXISTS original_payload jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE approval_requests
        DROP COLUMN IF EXISTS amended_by,
        DROP COLUMN IF EXISTS amended_at,
        DROP COLUMN IF EXISTS amendment_note,
        DROP COLUMN IF EXISTS original_payload
    `);
  }
}
