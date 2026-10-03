import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-warehouse permission to sell a pool below zero. Off for every store.
 *
 * Mirrors the ERP's `warehouses.allow_negative_stock` — same name, same default
 * — because the two sides have to agree about which vans may hold a negative.
 * The ERP already permits them, and cash-van refusing meant the reconciliation
 * could never bring a van that the ERP holds negative back into step: its
 * correcting voucher was refused by the very guard this flag now relaxes.
 */
export class WarehouseAllowNegativeStock1728400000000 implements MigrationInterface {
  name = 'WarehouseAllowNegativeStock1728400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS allow_negative_stock boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE warehouses DROP COLUMN IF EXISTS allow_negative_stock`);
  }
}
