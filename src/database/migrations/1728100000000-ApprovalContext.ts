import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * approval_requests.context — the figures a reviewer decides on, frozen when the
 * request is filed. First user: CREDIT_OVER_LIMIT (limit, balance, credit amount,
 * how far over). Nullable: every older request simply has none.
 */
export class ApprovalContext1728100000000 implements MigrationInterface {
  name = 'ApprovalContext1728100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS context jsonb NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE approval_requests DROP COLUMN IF EXISTS context`);
  }
}
