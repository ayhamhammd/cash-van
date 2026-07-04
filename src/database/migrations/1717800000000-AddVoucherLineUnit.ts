import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unit metadata on voucher lines. A line can be entered in a chosen unit
 * (e.g. boxes); item_qty is stored in base pieces (qty_of_unit × unit_base_qty)
 * so stock stays in pieces, while the unit used is recorded for display.
 */
export class AddVoucherLineUnit1717800000000 implements MigrationInterface {
  name = 'AddVoucherLineUnit1717800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" ADD COLUMN IF NOT EXISTS "qty_of_unit" numeric(14,3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" ADD COLUMN IF NOT EXISTS "unit_code" TEXT`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" ADD COLUMN IF NOT EXISTS "unit_name" TEXT`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" ADD COLUMN IF NOT EXISTS "unit_base_qty" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" DROP COLUMN IF EXISTS "unit_base_qty"`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" DROP COLUMN IF EXISTS "unit_name"`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" DROP COLUMN IF EXISTS "unit_code"`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" DROP COLUMN IF EXISTS "qty_of_unit"`,
    );
  }
}
