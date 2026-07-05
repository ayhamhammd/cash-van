import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * First-class price lists in FlowVan: `price_lists` (named lists) + item prices
 * (`price_list_items`), plus a per-customer assignment (`customers.price_list_id`).
 * origin distinguishes dashboard-authored ('local') from ERP-mirrored ('erp').
 */
export class PriceLists1721100000000 implements MigrationInterface {
  name = 'PriceLists1721100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "price_lists" (
        "id"         uuid NOT NULL DEFAULT uuid_generate_v4(),
        "code"       text NOT NULL,
        "name"       text NOT NULL,
        "origin"     text NOT NULL DEFAULT 'local',
        "erp_id"     text,
        "is_active"  boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        "version"    integer NOT NULL DEFAULT 1,
        CONSTRAINT "pk_price_lists" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_price_lists_code" ON "price_lists" ("code")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_price_lists_erp_id" ON "price_lists" ("erp_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "price_list_items" (
        "id"            uuid NOT NULL DEFAULT uuid_generate_v4(),
        "price_list_id" uuid NOT NULL,
        "item_id"       uuid NOT NULL,
        "unit_price"    integer NOT NULL,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "updated_at"    timestamptz NOT NULL DEFAULT now(),
        "deleted_at"    timestamptz,
        "version"       integer NOT NULL DEFAULT 1,
        CONSTRAINT "pk_price_list_items" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_price_list_item" ON "price_list_items" ("price_list_id", "item_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_price_list_items_list" ON "price_list_items" ("price_list_id")`,
    );

    // Per-customer assignment to a (local or mirrored) price list.
    await queryRunner.query(
      `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "price_list_id" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_customers_price_list" ON "customers" ("price_list_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_customers_price_list"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "price_list_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "price_list_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "price_lists"`);
  }
}
