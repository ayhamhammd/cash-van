import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ERP customer price lists → cash-van. A `customer_prices` cache of resolved
 * per-customer contract/list prices (fils), plus price-list assignment + the
 * manual-edit flag on customers.
 */
export class CustomerPrices1720900000000 implements MigrationInterface {
  name = 'CustomerPrices1720900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "customer_prices" (
        "id"                uuid NOT NULL DEFAULT uuid_generate_v4(),
        "customer_id"       uuid NOT NULL,
        "item_id"           uuid,
        "item_unit_id"      uuid,
        "erp_sku"           text NOT NULL,
        "barcode"           text,
        "unit_price"        integer NOT NULL,
        "price_source"      text,
        "erp_price_list_id" text,
        "synced_at"         timestamptz,
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        "updated_at"        timestamptz NOT NULL DEFAULT now(),
        "deleted_at"        timestamptz,
        "version"           integer NOT NULL DEFAULT 1,
        CONSTRAINT "pk_customer_prices" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_price_customer_sku" ON "customer_prices" ("customer_id", "erp_sku")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_customer_prices_customer" ON "customer_prices" ("customer_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "erp_price_list_id" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "erp_price_list_name" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "allow_manual_price_edit" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "allow_manual_price_edit"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "erp_price_list_name"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "erp_price_list_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_prices"`);
  }
}
