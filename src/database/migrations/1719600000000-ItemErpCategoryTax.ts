import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-item ERP category + tax-rate ids — chosen on the item form, sent to the ERP on push. */
export class ItemErpCategoryTax1719600000000 implements MigrationInterface {
  name = 'ItemErpCategoryTax1719600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "item_cart"
        ADD COLUMN IF NOT EXISTS "erp_category_id" text,
        ADD COLUMN IF NOT EXISTS "erp_tax_rate_id" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "item_cart"
        DROP COLUMN IF EXISTS "erp_tax_rate_id",
        DROP COLUMN IF EXISTS "erp_category_id"
    `);
  }
}
