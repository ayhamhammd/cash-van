import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Serial voucher numbering + return reference.
 *   - voucher_number_seq: one global sequence shared across all kinds/stores;
 *     the formatted number is <prefix>-<userCode><6-digit serial>.
 *   - reference_voucher_number: links a RETURN to its original SALE voucher.
 */
export class VoucherNumberingAndReturnRef1718000000000
  implements MigrationInterface
{
  name = 'VoucherNumberingAndReturnRef1718000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS "voucher_number_seq" START 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_headers" ADD COLUMN IF NOT EXISTS "reference_voucher_number" TEXT`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "voucher_headers" DROP COLUMN IF EXISTS "reference_voucher_number"`,
    );
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "voucher_number_seq"`);
  }
}
