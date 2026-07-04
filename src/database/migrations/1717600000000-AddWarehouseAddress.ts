import { MigrationInterface, QueryRunner } from 'typeorm';

/** Optional street/location address for a store (warehouse / van stock location). */
export class AddWarehouseAddress1717600000000 implements MigrationInterface {
  name = 'AddWarehouseAddress1717600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "warehouses" ADD COLUMN IF NOT EXISTS "wh_address" TEXT`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "warehouses" DROP COLUMN IF EXISTS "wh_address"`,
    );
  }
}
