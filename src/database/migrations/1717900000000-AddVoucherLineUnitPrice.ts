import { MigrationInterface, QueryRunner } from 'typeorm';

/** Persist the per-unit price on each voucher line so receipts can reprint exact figures. */
export class AddVoucherLineUnitPrice1717900000000 implements MigrationInterface {
  name = 'AddVoucherLineUnitPrice1717900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" ADD COLUMN IF NOT EXISTS "unit_price" numeric(14,3) NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" DROP COLUMN IF EXISTS "unit_price"`,
    );
  }
}
