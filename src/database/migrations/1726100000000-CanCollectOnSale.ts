import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-rep permission: take a partial payment on a CREDIT sale from the cart
 * (the "amount paid" field). Off by default. See docs/SPEC-pay-on-credit-sale.md.
 */
export class CanCollectOnSale1726100000000 implements MigrationInterface {
  name = 'CanCollectOnSale1726100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "can_collect_on_sale" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "can_collect_on_sale"`);
  }
}
