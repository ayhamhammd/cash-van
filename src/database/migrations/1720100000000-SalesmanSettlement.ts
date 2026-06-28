import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * End-of-Day salesman cash reconciliation. One row per settled period; the
 * rep's running balance is the latest row's new_balance_fils
 * (new = previous + expected − received). All money in fils.
 */
export class SalesmanSettlement1720100000000 implements MigrationInterface {
  name = 'SalesmanSettlement1720100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "salesman_settlement" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "rep_id" uuid NOT NULL,
        "period_from" date NOT NULL,
        "period_to" date NOT NULL,
        "expected_cash_fils" bigint NOT NULL DEFAULT 0,
        "collected_cash_fils" bigint NOT NULL DEFAULT 0,
        "collected_cheque_fils" bigint NOT NULL DEFAULT 0,
        "cash_sales_fils" bigint NOT NULL DEFAULT 0,
        "credit_sales_fils" bigint NOT NULL DEFAULT 0,
        "cash_returns_fils" bigint NOT NULL DEFAULT 0,
        "total_discount_fils" bigint NOT NULL DEFAULT 0,
        "previous_balance_fils" bigint NOT NULL DEFAULT 0,
        "received_fils" bigint NOT NULL DEFAULT 0,
        "new_balance_fils" bigint NOT NULL DEFAULT 0,
        "note" text,
        "created_by_user_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_salesman_settlement" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_settlement_rep_created" ON "salesman_settlement" ("rep_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "salesman_settlement"`);
  }
}
