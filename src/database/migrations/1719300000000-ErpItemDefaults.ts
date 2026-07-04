import { MigrationInterface, QueryRunner } from 'typeorm';

/** ERP default category + tax-rate ids, used when mirroring a cash-van item to the ERP. */
export class ErpItemDefaults1719300000000 implements MigrationInterface {
  name = 'ErpItemDefaults1719300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_settings"
        ADD COLUMN IF NOT EXISTS "erp_default_category_id" text,
        ADD COLUMN IF NOT EXISTS "erp_default_tax_rate_id" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_settings"
        DROP COLUMN IF EXISTS "erp_default_tax_rate_id",
        DROP COLUMN IF EXISTS "erp_default_category_id"
    `);
  }
}
