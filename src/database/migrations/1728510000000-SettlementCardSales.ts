import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Visa sales on the salesman settlement. They are paid — to the bank, not into
 * the van's cash — so they are shown beside cash and credit but never counted in
 * the cash the salesman hands in. Old settlements read 0.
 */
export class SettlementCardSales1728510000000 implements MigrationInterface {
  name = 'SettlementCardSales1728510000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE salesman_settlement ADD COLUMN IF NOT EXISTS card_sales_fils bigint NOT NULL DEFAULT 0`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE salesman_settlement DROP COLUMN IF EXISTS card_sales_fils`);
  }
}
