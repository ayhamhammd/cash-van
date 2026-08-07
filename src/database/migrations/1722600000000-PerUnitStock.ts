import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give stock a unit dimension, so one item can be sold as several units that
 * each own their quantity. See docs/SPEC-per-unit-stock.md §3.
 *
 * The grain becomes (item_number, stock_unit_code, store_number) — exactly the
 * ERP's (sku_id, warehouse_id), one cash-van pool per ERP SKU.
 *
 * `is_stock_unit` is what separates the two things `item_units` has always
 * conflated: a packaging unit (كرتونة ×12) is a way to *enter* a quantity of the
 * same goods and keeps drawing from the item's base pool, while a variant
 * (أحمر ×1) is a physically different good that owns its own pool. Every
 * existing row defaults to `false` and every existing line to `stock_unit_code
 * = ''`, so this is a behaviour-preserving upgrade: an install that never
 * re-syncs keeps one pool per item and sees no change at all.
 *
 * Quantities stay in base pieces at numeric(14,3). None of the arithmetic
 * moves — only the key gains a column.
 */
export class PerUnitStock1722600000000 implements MigrationInterface {
  name = 'PerUnitStock1722600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. The unit gains a kind (pool-owning or not) and its ERP identity.
    await queryRunner.query(`
      ALTER TABLE "item_units"
        ADD COLUMN "is_stock_unit" boolean NOT NULL DEFAULT false,
        ADD COLUMN "erp_sku_code"  text
    `);
    // Partial: only sync-touched units carry a SKU, and on an existing database
    // that is none of them.
    await queryRunner.query(`
      CREATE INDEX "idx_item_units_erp_sku"
        ON "item_units" ("erp_sku_code")
        WHERE "erp_sku_code" IS NOT NULL
    `);

    // 2. The line names the pool it moves. `unit_code` cannot serve as the key —
    //    it is a free-text snapshot and installed APKs post the Arabic display
    //    name in it — so the line also carries the authoritative item_units id.
    await queryRunner.query(`
      ALTER TABLE "voucher_transactions"
        ADD COLUMN "stock_unit_code" text NOT NULL DEFAULT '',
        ADD COLUMN "item_unit_id"    uuid REFERENCES "item_units"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_voucher_transactions_stock_unit"
        ON "voucher_transactions" ("item_number", "stock_unit_code")
    `);

    // 3. Van stock is one row per pool, not per product.
    await queryRunner.query(`
      ALTER TABLE "van_stock"
        ADD COLUMN "stock_unit_code" text NOT NULL DEFAULT ''
    `);
    await queryRunner.query(
      `ALTER TABLE "van_stock" DROP CONSTRAINT "uq_van_stock_rep_product"`,
    );
    await queryRunner.query(`
      ALTER TABLE "van_stock"
        ADD CONSTRAINT "uq_van_stock_rep_product_unit"
        UNIQUE ("rep_id", "product_id", "stock_unit_code")
    `);

    // 4. Rebuild item_balance with the unit dimension. Adding a column to the
    //    GROUP BY splits rows only where stock_unit_code <> '', and right after
    //    this migration nothing is — so today's readers keep returning today's
    //    numbers and are then updated deliberately, one at a time.
    await queryRunner.query(`DROP VIEW IF EXISTS "item_balance"`);
    await queryRunner.query(`
      CREATE VIEW "item_balance" AS
      SELECT
        ic.item_number                           AS item_number,
        ic.item_name                             AS item_name,
        m.store_number                           AS stock_number,
        COALESCE(m.stock_unit_code, '')          AS stock_unit_code,
        COALESCE(SUM(m.delta), 0)::numeric(14,3) AS qty
      FROM item_cart ic
      LEFT JOIN (
        SELECT vt.item_number,
               vt.from_store_number AS store_number,
               vt.stock_unit_code   AS stock_unit_code,
               -vt.item_qty         AS delta
        FROM voucher_transactions vt
        JOIN voucher_headers vh
          ON vh.voucher_number = vt.voucher_number
         AND vh.is_posted = TRUE
        WHERE vt.from_store_number IS NOT NULL
        UNION ALL
        SELECT vt.item_number,
               vt.to_store_number AS store_number,
               vt.stock_unit_code AS stock_unit_code,
               vt.item_qty        AS delta
        FROM voucher_transactions vt
        JOIN voucher_headers vh
          ON vh.voucher_number = vt.voucher_number
         AND vh.is_posted = TRUE
        WHERE vt.to_store_number IS NOT NULL
      ) m ON m.item_number = ic.item_number
      GROUP BY ic.item_number, ic.item_name, m.store_number, COALESCE(m.stock_unit_code, '')
    `);

    // 5. The per-item roll-up, so a caller that legitimately means "all colours"
    //    does not have to know the grain.
    await queryRunner.query(`
      CREATE VIEW "item_balance_total" AS
      SELECT
        item_number,
        item_name,
        stock_number,
        SUM(qty)::numeric(14,3) AS qty
      FROM item_balance
      GROUP BY item_number, item_name, stock_number
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP VIEW IF EXISTS "item_balance_total"`);

    // Restore the from/to-store view of 1717400000000-VoucherStoreTransfer.
    await queryRunner.query(`DROP VIEW IF EXISTS "item_balance"`);
    await queryRunner.query(`
      CREATE VIEW "item_balance" AS
      SELECT
        ic.item_number               AS item_number,
        ic.item_name                 AS item_name,
        m.store_number               AS stock_number,
        COALESCE(SUM(m.delta), 0)::numeric(14,3) AS qty
      FROM item_cart ic
      LEFT JOIN (
        SELECT vt.item_number,
               vt.from_store_number AS store_number,
               -vt.item_qty         AS delta
        FROM voucher_transactions vt
        JOIN voucher_headers vh
          ON vh.voucher_number = vt.voucher_number
         AND vh.is_posted = TRUE
        WHERE vt.from_store_number IS NOT NULL
        UNION ALL
        SELECT vt.item_number,
               vt.to_store_number AS store_number,
               vt.item_qty        AS delta
        FROM voucher_transactions vt
        JOIN voucher_headers vh
          ON vh.voucher_number = vt.voucher_number
         AND vh.is_posted = TRUE
        WHERE vt.to_store_number IS NOT NULL
      ) m ON m.item_number = ic.item_number
      GROUP BY ic.item_number, ic.item_name, m.store_number
    `);

    // Collapsing the van back to one row per product can violate the old unique
    // constraint, so fold the variant pools into the base row first.
    await queryRunner.query(`
      UPDATE "van_stock" b
         SET "quantity" = b."quantity" + v."quantity",
             "reserved" = b."reserved" + v."reserved"
        FROM (
          SELECT "rep_id", "product_id",
                 SUM("quantity") AS quantity,
                 SUM("reserved") AS reserved
            FROM "van_stock"
           WHERE "stock_unit_code" <> ''
           GROUP BY "rep_id", "product_id"
        ) v
       WHERE b."rep_id" = v."rep_id"
         AND b."product_id" = v."product_id"
         AND b."stock_unit_code" = ''
    `);
    await queryRunner.query(
      `DELETE FROM "van_stock" WHERE "stock_unit_code" <> ''`,
    );
    await queryRunner.query(
      `ALTER TABLE "van_stock" DROP CONSTRAINT IF EXISTS "uq_van_stock_rep_product_unit"`,
    );
    await queryRunner.query(`
      ALTER TABLE "van_stock"
        ADD CONSTRAINT "uq_van_stock_rep_product"
        UNIQUE ("rep_id", "product_id")
    `);
    await queryRunner.query(
      `ALTER TABLE "van_stock" DROP COLUMN IF EXISTS "stock_unit_code"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_voucher_transactions_stock_unit"`,
    );
    await queryRunner.query(`
      ALTER TABLE "voucher_transactions"
        DROP COLUMN IF EXISTS "item_unit_id",
        DROP COLUMN IF EXISTS "stock_unit_code"
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_item_units_erp_sku"`);
    await queryRunner.query(`
      ALTER TABLE "item_units"
        DROP COLUMN IF EXISTS "erp_sku_code",
        DROP COLUMN IF EXISTS "is_stock_unit"
    `);
  }
}
