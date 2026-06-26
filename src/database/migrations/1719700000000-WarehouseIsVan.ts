import { MigrationInterface, QueryRunner } from 'typeorm';

/** Store type — a warehouse is either a normal depot or a van store (rep van). */
export class WarehouseIsVan1719700000000 implements MigrationInterface {
  name = 'WarehouseIsVan1719700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "warehouses" ADD COLUMN IF NOT EXISTS "is_van" boolean NOT NULL DEFAULT false
    `);
    // Existing rep-linked stores (vanId points to them) are van stores.
    await queryRunner.query(`
      UPDATE "warehouses" w SET "is_van" = true
      WHERE EXISTS (SELECT 1 FROM "reps" r WHERE r."van_id" = w."id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "warehouses" DROP COLUMN IF EXISTS "is_van"`);
  }
}
