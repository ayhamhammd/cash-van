import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `warehouses.is_main` — mirror the ERP's "main store" flag so the ORDER flow can
 * detect the central depot FROM the ERP instead of guessing the lowest-numbered
 * one. The ERP already sends `isMain` on every warehouse; until now VanFlow threw
 * it away, so after a settings reset the order screen sourced quantities from an
 * arbitrary depot. Default false; the next warehouse sync fills it in.
 */
export class WarehouseIsMain1724200000000 implements MigrationInterface {
  name = 'WarehouseIsMain1724200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "warehouses" ADD COLUMN IF NOT EXISTS "is_main" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "warehouses" DROP COLUMN IF EXISTS "is_main"`);
  }
}
