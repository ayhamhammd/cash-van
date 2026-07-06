import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Accounts receivable (debt / ذمم) — add `credit_hold` to customers so the ERP's
 * hard-stop flag mirrors into FlowVan and the dashboard/van can block credit sales
 * for held customers regardless of limit. `payment_terms` + `credit_limit` +
 * `total_debt` already exist. See docs/SPEC-accounts-receivable.md.
 */
export class CustomerCreditHold1721200000000 implements MigrationInterface {
  name = 'CustomerCreditHold1721200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "credit_hold" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "credit_hold"`);
  }
}
