import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `item_cart.alt_group` — which ERP "Item Alternatives" group the item belongs to.
 *
 * The ERP keeps substitutes as pairs (item_alternatives). Mirrored here as ONE key
 * per group — every item in a mutually-substitutable set carries the same value —
 * because that is the only question the consumer asks: may these two lines be
 * printed as one? NULL means the item has no declared alternative, and an item
 * with no group never merges with anything.
 */
export class ItemAlternativeGroup1726300000000 implements MigrationInterface {
  name = 'ItemAlternativeGroup1726300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "item_cart" ADD COLUMN IF NOT EXISTS "alt_group" text`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_item_cart_alt_group" ON "item_cart" ("alt_group")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_item_cart_alt_group"`);
    await q.query(`ALTER TABLE "item_cart" DROP COLUMN IF EXISTS "alt_group"`);
  }
}
