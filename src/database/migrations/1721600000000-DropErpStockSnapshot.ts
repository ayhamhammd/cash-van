import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The van/stock pull (ERP -> cash-van on-hand reconciliation) was removed from
 * the sync loop entirely — repeated double-counting/opening-balance bugs and
 * API-key rate-limit exhaustion during a full sync made it unreliable, and the
 * client decided stock should only move via cash-van's own local vouchers
 * (sales/transfers/adjustments), not be overwritten by a periodic ERP pull.
 * This drops the now-unused snapshot table and its sync cursor.
 */
export class DropErpStockSnapshot1721600000000 implements MigrationInterface {
  name = 'DropErpStockSnapshot1721600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "erp_stock_snapshot"`);
    await queryRunner.query(`DELETE FROM "erp_sync_cursor" WHERE "entity" = 'van/stock'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "erp_stock_snapshot" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "store" text NOT NULL,
        "sku_code" text NOT NULL,
        "quantity" integer NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_erp_stock_snapshot" PRIMARY KEY ("id"),
        CONSTRAINT "uq_erp_stock_snapshot_store_sku" UNIQUE ("store", "sku_code")
      )
    `);
  }
}
