import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-stock balances driven by explicit from/to stores on each voucher line.
 *
 *   - from_store_number → stock that LOSES qty (SALE, OUT side of a TRANSFER)
 *   - to_store_number   → stock that GAINS qty (RETURN, IN side of a TRANSFER)
 *
 * A TRANSFER line now sets both, so one posted voucher decrements the source
 * stock and increments the destination stock — no separate IN voucher.
 *
 * Existing rows are backfilled from the legacy signed_qty/store_number pair so
 * the rebuilt item_balance view reproduces the previous numbers exactly.
 */
export class VoucherStoreTransfer1717400000000 implements MigrationInterface {
  name = 'VoucherStoreTransfer1717400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. New explicit stock-movement columns.
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" ADD COLUMN IF NOT EXISTS "from_store_number" TEXT`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" ADD COLUMN IF NOT EXISTS "to_store_number" TEXT`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions"
         ADD CONSTRAINT "fk_voucher_transactions_from_store"
         FOREIGN KEY ("from_store_number") REFERENCES "warehouses"("wh_number") ON DELETE RESTRICT`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions"
         ADD CONSTRAINT "fk_voucher_transactions_to_store"
         FOREIGN KEY ("to_store_number") REFERENCES "warehouses"("wh_number") ON DELETE RESTRICT`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_voucher_transactions_from_store" ON "voucher_transactions" ("from_store_number")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_voucher_transactions_to_store" ON "voucher_transactions" ("to_store_number")`,
    );

    // 2. Backfill from the legacy signed_qty/store_number pair.
    await queryRunner.query(
      `UPDATE "voucher_transactions"
         SET "from_store_number" = "store_number"
       WHERE "store_number" IS NOT NULL AND "signed_qty" < 0`,
    );
    await queryRunner.query(
      `UPDATE "voucher_transactions"
         SET "to_store_number" = "store_number"
       WHERE "store_number" IS NOT NULL AND "signed_qty" > 0`,
    );

    // 3. Make sure the stock-movement header kinds exist:
    //    TRANSFER (sign 0 — its line from/to stores carry the movement),
    //    IN (stock in, +1) and OUT (stock out, -1).
    await queryRunner.query(
      `INSERT INTO "transaction_kinds" ("trans_kind", "trans_name", "sign")
       VALUES ('TRANSFER', 'تحويل بين المخازن', 0),
              ('IN', 'إدخال للمخزن', 1),
              ('OUT', 'إخراج من المخزن', -1)
       ON CONFLICT ("trans_kind") DO NOTHING`,
    );

    // 4. Rebuild the item_balance view to read from/to stores.
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the original signed_qty-based view.
    await queryRunner.query(`DROP VIEW IF EXISTS "item_balance"`);
    await queryRunner.query(`
      CREATE VIEW "item_balance" AS
      SELECT
        ic.item_number               AS item_number,
        ic.item_name                 AS item_name,
        vt.store_number              AS stock_number,
        COALESCE(SUM(vt.signed_qty), 0)::numeric(14,3) AS qty
      FROM item_cart ic
      LEFT JOIN voucher_transactions vt
        ON vt.item_number = ic.item_number
      LEFT JOIN voucher_headers vh
        ON vh.voucher_number = vt.voucher_number
       AND vh.is_posted = TRUE
      GROUP BY ic.item_number, ic.item_name, vt.store_number
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_voucher_transactions_to_store"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_voucher_transactions_from_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" DROP CONSTRAINT IF EXISTS "fk_voucher_transactions_to_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" DROP CONSTRAINT IF EXISTS "fk_voucher_transactions_from_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" DROP COLUMN IF EXISTS "to_store_number"`,
    );
    await queryRunner.query(
      `ALTER TABLE "voucher_transactions" DROP COLUMN IF EXISTS "from_store_number"`,
    );
    await queryRunner.query(
      `DELETE FROM "transaction_kinds" WHERE "trans_kind" IN ('TRANSFER', 'IN', 'OUT')`,
    );
  }
}
