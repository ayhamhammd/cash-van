import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-warehouse payment (C) number for collections. Reuses voucher_counters
 * with trans_kind='PAYMENT' (store_number = the rep's van store) so each
 * warehouse has its own sequential C series, e.g. C-VAN-01-000001.
 */
export class CollectionNumber1719800000000 implements MigrationInterface {
  name = 'CollectionNumber1719800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "collection_number" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "collections" DROP COLUMN IF EXISTS "collection_number"`);
  }
}
