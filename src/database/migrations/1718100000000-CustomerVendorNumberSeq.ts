import { MigrationInterface, QueryRunner } from 'typeorm';

/** Serial numbering sequences for customers (CUST-…) and vendors (VEN-…). */
export class CustomerVendorNumberSeq1718100000000 implements MigrationInterface {
  name = 'CustomerVendorNumberSeq1718100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS "customer_number_seq" START 1`,
    );
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS "vendor_number_seq" START 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "vendor_number_seq"`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "customer_number_seq"`);
  }
}
