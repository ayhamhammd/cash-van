import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Item targets: per salesman, per month, per item — a quantity (in the item's
 * base unit) or an amount (fils) to sell, next to the monthly sales_targets.
 * Behind the Program features switch app_settings.item_targets_enabled (off by
 * default). Measured only: commission is not paid on them in this version.
 *
 * One target per (rep, year, month, item); exactly one of target_qty /
 * target_fils is set, matching the metric, and it is positive.
 */
export class ItemTargets1728740000000 implements MigrationInterface {
  name = 'ItemTargets1728740000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "sales_item_targets" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "rep_id"      uuid NOT NULL REFERENCES "reps"("id") ON DELETE CASCADE,
        "year"        integer NOT NULL,
        "month"       integer NOT NULL,
        "item_number" text NOT NULL REFERENCES "item_cart"("item_number") ON DELETE CASCADE,
        "metric"      text NOT NULL,
        "target_qty"  numeric(14,3),
        "target_fils" bigint,
        "notes"       text,
        "created_by"  uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_sales_item_targets_month" CHECK ("month" BETWEEN 1 AND 12),
        CONSTRAINT "chk_sales_item_targets_metric" CHECK (
             ("metric" = 'QTY'    AND "target_qty"  IS NOT NULL AND "target_qty"  > 0 AND "target_fils" IS NULL)
          OR ("metric" = 'AMOUNT' AND "target_fils" IS NOT NULL AND "target_fils" > 0 AND "target_qty"  IS NULL))
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_sales_item_targets_rep_period_item"
         ON "sales_item_targets" ("rep_id", "year", "month", "item_number")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_sales_item_targets_period" ON "sales_item_targets" ("year", "month")`,
    );
    await q.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "item_targets_enabled" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "item_targets_enabled"`);
    await q.query(`DROP TABLE IF EXISTS "sales_item_targets"`);
  }
}
