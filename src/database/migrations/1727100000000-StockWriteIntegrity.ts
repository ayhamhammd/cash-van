import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Close the two gaps the original van_stock constraints left open.
 *
 * `van_stock.quantity` has had `ck_van_stock_qty_nonneg` since the table was
 * created (1716100000000), so a negative quantity was never storable. What the
 * `Math.max(0, quantity - qty)` in `applyLineToVan` actually did was keep that
 * constraint from ever firing: an overdraft was written as 0 instead of being
 * refused, so a pool that had been oversold by three simply read "empty". The
 * number stayed legal and became wrong. The code now refuses
 * (docs/SPEC-stock-write-integrity.md §4.1) rather than clamping.
 *
 * Genuinely new here:
 *
 *  - `reserved` had NO constraint, and unlike `quantity` it was reachable —
 *    which is exactly what the `van_stock_inconsistent` health check
 *    (1722500000000-AiChecks.ts:107) was built to detect after the fact.
 *  - `damaged_stock` was created (1725900000000) without one at all.
 *  - `stock_integrity_findings`, so drift is recorded where someone will see it
 *    instead of being rediscovered by a physical count.
 */
export class StockWriteIntegrity1727100000000 implements MigrationInterface {
  name = 'StockWriteIntegrity1727100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "stock_integrity_findings" (
        "id" bigserial NOT NULL,
        "found_at" timestamptz NOT NULL DEFAULT now(),
        "rep_id" uuid NOT NULL,
        "product_id" uuid NOT NULL,
        "stock_unit_code" text NOT NULL DEFAULT '',
        "van_stock_qty" numeric(14,3),
        "ledger_qty" numeric(14,3),
        "erp_qty" numeric(14,3),
        "kind" text NOT NULL,
        "detail" text,
        "resolved_at" timestamptz,
        CONSTRAINT "pk_stock_integrity_findings" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "idx_stock_integrity_open"
        ON "stock_integrity_findings" ("found_at" DESC)
        WHERE "resolved_at" IS NULL
    `);

    // Record, then repair. `quantity` cannot be negative (the constraint has
    // always been there), so in practice this finds over-reservations — a
    // reservation the pool can no longer cover, which is the leak left by an
    // ORDER cancelled without releasing it.
    await q.query(`
      INSERT INTO "stock_integrity_findings"
        (rep_id, product_id, stock_unit_code, van_stock_qty, kind, detail)
      SELECT rep_id, product_id, stock_unit_code, quantity,
             CASE WHEN quantity < 0 THEN 'negative' ELSE 'reserved_exceeds_stock' END,
             'quantity=' || quantity || ', reserved=' || reserved
        FROM "van_stock"
       WHERE quantity < 0 OR reserved < 0 OR reserved > quantity
    `);
    await q.query(`
      INSERT INTO "stock_integrity_findings"
        (rep_id, product_id, stock_unit_code, van_stock_qty, kind, detail)
      SELECT rep_id, product_id, stock_unit_code, quantity, 'negative',
             'damaged_stock'
        FROM "damaged_stock"
       WHERE quantity < 0
    `);

    await q.query(`UPDATE "van_stock" SET quantity = 0 WHERE quantity < 0`);
    await q.query(`UPDATE "van_stock" SET reserved = 0 WHERE reserved < 0`);
    await q.query(`UPDATE "damaged_stock" SET quantity = 0 WHERE quantity < 0`);

    // `quantity >= 0` is deliberately NOT added: ck_van_stock_qty_nonneg has
    // covered it since 1716100000000. A second identical CHECK would cost a
    // scan on every write and tell a later reader there were two rules.
    //
    // NOT VALID first, then VALIDATE: the repair above already satisfies the
    // constraint, and splitting it keeps the ACCESS EXCLUSIVE lock short on a
    // table every sale touches.
    await q.query(`
      ALTER TABLE "van_stock"
        ADD CONSTRAINT "chk_van_stock_reserved_nonneg" CHECK (reserved >= 0) NOT VALID
    `);
    await q.query(`ALTER TABLE "van_stock" VALIDATE CONSTRAINT "chk_van_stock_reserved_nonneg"`);
    await q.query(`
      ALTER TABLE "damaged_stock"
        ADD CONSTRAINT "chk_damaged_stock_qty_nonneg" CHECK (quantity >= 0) NOT VALID
    `);
    await q.query(
      `ALTER TABLE "damaged_stock" VALIDATE CONSTRAINT "chk_damaged_stock_qty_nonneg"`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "damaged_stock" DROP CONSTRAINT IF EXISTS "chk_damaged_stock_qty_nonneg"`,
    );
    await q.query(
      `ALTER TABLE "van_stock" DROP CONSTRAINT IF EXISTS "chk_van_stock_reserved_nonneg"`,
    );
    await q.query(`DROP TABLE IF EXISTS "stock_integrity_findings"`);
  }
}
