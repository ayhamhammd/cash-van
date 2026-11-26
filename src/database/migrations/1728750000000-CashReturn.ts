import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cash or credit on a salesman's return (docs/SPEC-cash-returns.md).
 *
 *  - users.can_cash_return: may this salesman pay a return back in cash from
 *    the van? Off for everyone: until the office turns it on, every return
 *    stays customer credit, exactly as before.
 *  - salesman_settlement.cash_refunds_fils: the cash a settled period paid
 *    out on returns — the figure expected cash was reduced by. Zero for every
 *    settlement already made, which is what they were.
 */
export class CashReturn1728750000000 implements MigrationInterface {
  name = 'CashReturn1728750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS can_cash_return boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE salesman_settlement
        ADD COLUMN IF NOT EXISTS cash_refunds_fils bigint NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE salesman_settlement DROP COLUMN IF EXISTS cash_refunds_fils`);
    await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS can_cash_return`);
  }
}
