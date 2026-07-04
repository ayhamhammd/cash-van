import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Voucher-driven stock flow:
 *   - van_stock gains a `reserved` quantity (committed to open ORDER vouchers
 *     but not yet shipped). Available = quantity - reserved.
 *   - voucher_headers gains `is_fulfilled` so an ORDER's reservation can be
 *     released and turned into an actual stock-out exactly once.
 */
export class VoucherStockPosting1717300000000 implements MigrationInterface {
  name = 'VoucherStockPosting1717300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "van_stock" ADD COLUMN IF NOT EXISTS "reserved" INTEGER NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_headers" ADD COLUMN IF NOT EXISTS "is_fulfilled" BOOLEAN NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "voucher_headers" DROP COLUMN IF EXISTS "is_fulfilled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "van_stock" DROP COLUMN IF EXISTS "reserved"`,
    );
  }
}
