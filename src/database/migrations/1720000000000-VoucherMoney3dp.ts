import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Jordan money is fils (JOD × 1000 = 3 decimals). Voucher money columns were
 * numeric(14,2) (qirsh), which silently dropped a decimal and caused the app /
 * dashboard / ERP totals to disagree. Widen the money columns to numeric(14,3)
 * so the canonical fils-based engine (voucher-calc.ts) round-trips exactly.
 */
export class VoucherMoney3dp1720000000000 implements MigrationInterface {
  name = 'VoucherMoney3dp1720000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Header totals
    await queryRunner.query(`ALTER TABLE "voucher_headers" ALTER COLUMN "total" TYPE numeric(14,3)`);
    await queryRunner.query(`ALTER TABLE "voucher_headers" ALTER COLUMN "total_tax" TYPE numeric(14,3)`);
    await queryRunner.query(`ALTER TABLE "voucher_headers" ALTER COLUMN "net_total" TYPE numeric(14,3)`);
    await queryRunner.query(
      `ALTER TABLE "voucher_headers" ALTER COLUMN "total_discount_value" TYPE numeric(14,3)`,
    );
    // Line money
    await queryRunner.query(`ALTER TABLE "voucher_transactions" ALTER COLUMN "total" TYPE numeric(14,3)`);
    await queryRunner.query(`ALTER TABLE "voucher_transactions" ALTER COLUMN "net_total" TYPE numeric(14,3)`);
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" ALTER COLUMN "discount_value" TYPE numeric(14,3)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "voucher_headers" ALTER COLUMN "total" TYPE numeric(14,2)`);
    await queryRunner.query(`ALTER TABLE "voucher_headers" ALTER COLUMN "total_tax" TYPE numeric(14,2)`);
    await queryRunner.query(`ALTER TABLE "voucher_headers" ALTER COLUMN "net_total" TYPE numeric(14,2)`);
    await queryRunner.query(
      `ALTER TABLE "voucher_headers" ALTER COLUMN "total_discount_value" TYPE numeric(14,2)`,
    );
    await queryRunner.query(`ALTER TABLE "voucher_transactions" ALTER COLUMN "total" TYPE numeric(14,2)`);
    await queryRunner.query(`ALTER TABLE "voucher_transactions" ALTER COLUMN "net_total" TYPE numeric(14,2)`);
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" ALTER COLUMN "discount_value" TYPE numeric(14,2)`,
    );
  }
}
