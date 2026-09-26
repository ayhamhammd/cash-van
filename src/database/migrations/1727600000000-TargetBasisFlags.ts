import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * How a salesman's target progress is measured.
 *
 * targets_include_tax: sales figures and progress with tax (the default, as
 * before) or on the amount before tax.
 *
 * targets_sales_include_cash: whether cash sales count in the sales figure. A
 * cash sale is a sale and a collection at the same moment; some companies want
 * the sales target to measure what went on account only. Cash sales are still
 * shown on their own either way.
 *
 * Both default to TRUE so an existing install measures exactly as it did.
 */
export class TargetBasisFlags1727600000000 implements MigrationInterface {
  name = 'TargetBasisFlags1727600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "targets_include_tax" boolean NOT NULL DEFAULT true`,
    );
    await q.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "targets_sales_include_cash" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "targets_sales_include_cash"`);
    await q.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "targets_include_tax"`);
  }
}
