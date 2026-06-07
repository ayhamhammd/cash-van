import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Company-level tax calculation method on the single app_settings row:
 *   - EXCLUSIVE → unit prices are net; tax is added on top (default)
 *   - INCLUSIVE → unit prices already include tax
 */
export class AddTaxCalcMethod1717500000000 implements MigrationInterface {
  name = 'AddTaxCalcMethod1717500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "tax_calc_method" TEXT NOT NULL DEFAULT 'EXCLUSIVE'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "tax_calc_method"`,
    );
  }
}
