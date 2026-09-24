import { MigrationInterface, QueryRunner } from 'typeorm';

export class VoucherNotes1727500000000 implements MigrationInterface {
  name = 'VoucherNotes1727500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE voucher_headers ADD COLUMN IF NOT EXISTS notes text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE voucher_headers DROP COLUMN IF EXISTS notes`);
  }
}
