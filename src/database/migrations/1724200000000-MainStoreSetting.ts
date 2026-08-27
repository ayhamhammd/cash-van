import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The MAIN STORE an order is fulfilled from.
 *
 * A van ORDER is a request for a voucher drawn from a central depot, not the
 * salesman's van — so order-item quantities must be read from this store, not the
 * van. Admin-selectable in settings; nullable, because when unset the app resolves
 * it from the ERP default depot instead. Holds a warehouse `wh_number`.
 */
export class MainStoreSetting1724200000000 implements MigrationInterface {
  name = 'MainStoreSetting1724200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "main_store_number" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "main_store_number"`,
    );
  }
}
