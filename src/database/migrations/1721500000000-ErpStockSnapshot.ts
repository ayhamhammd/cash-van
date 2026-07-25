import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ERP stock sync switched from the movements ledger (`/api/v1/stock-movements`)
 * to the van/stock snapshot (`/api/v1/van/stock`) — see docs/ERP-SYNC.md. This
 * table holds the last-known quantity per (store, ERP SKU) so each poll can
 * compute a net delta; it replaces the per-store `movements:*` cursor rows.
 */
export class ErpStockSnapshot1721500000000 implements MigrationInterface {
  name = 'ErpStockSnapshot1721500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

    // Drop the old per-store movement cursors — replaced by this snapshot table.
    await queryRunner.query(
      `DELETE FROM "erp_sync_cursor" WHERE "entity" LIKE 'movements:%'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "erp_stock_snapshot"`);
  }
}
