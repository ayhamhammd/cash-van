import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ERP "direct export" toggle. When ON (default), posted vouchers + confirmed
 * collections push to the ERP automatically; when OFF they wait for manual
 * export in the dashboard's ERP Export page.
 */
export class ErpDirectExport1719900000000 implements MigrationInterface {
  name = 'ErpDirectExport1719900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_settings"
      ADD COLUMN IF NOT EXISTS "erp_direct_export" boolean NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "erp_direct_export"`,
    );
  }
}
