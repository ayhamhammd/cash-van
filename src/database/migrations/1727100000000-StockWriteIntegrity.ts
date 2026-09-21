import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make a negative stock row impossible, and record the ones already there.
 *
 * `applyLineToVan` used to write `Math.max(0, quantity - qty)`, which absorbed
 * an overdraft silently — erasing the only signal that stock accounting had
 * broken, at the moment it broke. The code now refuses instead of clamping
 * (docs/SPEC-stock-write-integrity.md §4.1); these CHECK constraints are what
 * makes that guarantee hold against every other writer, now and later.
 *
 * Rows already negative are a symptom of the old behaviour, so they are
 * RECORDED before being lifted to zero. Quietly correcting them a second time
 * would throw away the evidence of how far the drift had gone at this site.
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

    // Record, then repair. The count this inserts is the measured size of the
    // silent-clamp problem at this installation.
    await q.query(`
      INSERT INTO "stock_integrity_findings"
        (rep_id, product_id, stock_unit_code, van_stock_qty, kind, detail)
      SELECT rep_id, product_id, stock_unit_code, quantity, 'negative',
             'quantity=' || quantity || ', reserved=' || reserved
        FROM "van_stock"
       WHERE quantity < 0 OR reserved < 0
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

    // NOT VALID first, then VALIDATE: the repair above already satisfies the
    // constraint, and splitting it keeps the ACCESS EXCLUSIVE lock short on a
    // table every sale touches.
    await q.query(`
      ALTER TABLE "van_stock"
        ADD CONSTRAINT "chk_van_stock_qty_nonneg" CHECK (quantity >= 0) NOT VALID
    `);
    await q.query(`ALTER TABLE "van_stock" VALIDATE CONSTRAINT "chk_van_stock_qty_nonneg"`);
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
    await q.query(
      `ALTER TABLE "van_stock" DROP CONSTRAINT IF EXISTS "chk_van_stock_qty_nonneg"`,
    );
    await q.query(`DROP TABLE IF EXISTS "stock_integrity_findings"`);
  }
}
