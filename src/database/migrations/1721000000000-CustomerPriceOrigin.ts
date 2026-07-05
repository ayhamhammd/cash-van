import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Let the FlowVan dashboard author customer prices locally (not only mirror the
 * ERP). `origin` distinguishes ERP-synced rows ('erp', rebuilt/pruned on each
 * sync) from dashboard-authored ones ('local', sticky — the sync never touches
 * them, since the ERP has no API to receive them back).
 */
export class CustomerPriceOrigin1721000000000 implements MigrationInterface {
  name = 'CustomerPriceOrigin1721000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "customer_prices" ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'erp'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "customer_prices" DROP COLUMN IF EXISTS "origin"`);
  }
}
