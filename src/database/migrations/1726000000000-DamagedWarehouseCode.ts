import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The ERP warehouse code a damaged/expired return is pushed to (instead of the
 * van), so the ERP quarantines the goods rather than re-adding them to sellable
 * van stock. Null → fall back to the van (feature effectively off ERP-side).
 * See docs/SPEC-damaged-expired-returns.md §8b.
 */
export class DamagedWarehouseCode1726000000000 implements MigrationInterface {
  name = 'DamagedWarehouseCode1726000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "damaged_warehouse_code" text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "damaged_warehouse_code"`);
  }
}
