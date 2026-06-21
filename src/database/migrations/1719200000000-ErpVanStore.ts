import { MigrationInterface, QueryRunner } from 'typeorm';

/** Map the ERP van warehouse to a cash-van store, for inbound stock sync. */
export class ErpVanStore1719200000000 implements MigrationInterface {
  name = 'ErpVanStore1719200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "erp_van_store" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "erp_van_store"`);
  }
}
