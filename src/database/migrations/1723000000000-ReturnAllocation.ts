import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Return-by-item: track how much of each sale line has already come back.
 *
 * See docs/RETURNS-without-a-sale-voucher.md. Returning items without naming a
 * sale means walking a customer's past sale lines and taking from each in turn —
 * which is only safe if we know what is still returnable. Without this column
 * the same units can be returned repeatedly, one voucher at a time, and nothing
 * anywhere notices.
 *
 * Backfilled from existing referenced returns so historical sales do not appear
 * fully returnable on day one — that would let a customer return goods they
 * already returned, and the allocator would happily build the document.
 */
export class ReturnAllocation1723000000000 implements MigrationInterface {
  name = 'ReturnAllocation1723000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "voucher_transactions"
        ADD COLUMN "qty_returned" numeric(14,3) NOT NULL DEFAULT 0`);

    // Never exceed what was sold. A CHECK rather than trust in the service:
    // over-return is the one corruption here that is silent and compounding.
    await q.query(`
      ALTER TABLE "voucher_transactions"
        ADD CONSTRAINT "vt_qty_returned_within_sold"
        CHECK ("qty_returned" >= 0 AND "qty_returned" <= "item_qty")`);

    // Backfill: existing RETURN vouchers that name a source sale.
    //
    // Matched on (voucher, item, unit) — NOT item alone. Cash van sells the same
    // item in several units, and a carton returned against a piece line would
    // consume the wrong allowance. LEAST() floors the result at what was sold so
    // a legacy over-return cannot violate the CHECK added above.
    await q.query(`
      WITH returned AS (
        SELECT h.reference_voucher_number AS sale_voucher,
               t.item_number,
               t.item_unit_id,
               SUM(t.item_qty) AS qty
          FROM voucher_headers h
          JOIN voucher_transactions t ON t.voucher_number = h.voucher_number
         WHERE h.trans_kind = 'RETURN'
           AND h.is_posted = true
           AND h.deleted_at IS NULL
           AND h.reference_voucher_number IS NOT NULL
         GROUP BY 1, 2, 3
      )
      UPDATE voucher_transactions vt
         SET qty_returned = LEAST(vt.item_qty, r.qty)
        FROM returned r
       WHERE vt.voucher_number = r.sale_voucher
         AND vt.item_number    = r.item_number
         AND vt.item_unit_id IS NOT DISTINCT FROM r.item_unit_id`);

    // The allocator's hot path: "still-returnable sale lines for these items".
    await q.query(`
      CREATE INDEX "idx_vt_returnable"
        ON "voucher_transactions" ("item_number", "item_unit_id")
        WHERE "qty_returned" < "item_qty"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_vt_returnable"`);
    await q.query(`
      ALTER TABLE "voucher_transactions"
        DROP CONSTRAINT IF EXISTS "vt_qty_returned_within_sold"`);
    await q.query(`ALTER TABLE "voucher_transactions" DROP COLUMN "qty_returned"`);
  }
}
