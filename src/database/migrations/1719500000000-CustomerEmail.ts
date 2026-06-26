import { MigrationInterface, QueryRunner } from 'typeorm';

/** Customer email — aligns the cash-van customer with the ERP customer (code/name/email/phone/taxNumber). */
export class CustomerEmail1719500000000 implements MigrationInterface {
  name = 'CustomerEmail1719500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "email" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "email"`);
  }
}
