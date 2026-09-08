import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Targets and commission rates for the two things a salesman is paid on.
 *
 * A salesman here earns on WHAT THEY SOLD and on WHAT THEY COLLECTED, and the
 * two are set and rewarded independently — a typical arrangement is 3% on a cash
 * sale, 1.5% on a credit sale, and a further 1.5% when that credit is finally
 * collected. The old shape could not express any of it: one target per month, on
 * either an amount or a quantity, with a single rate living on the rep.
 *
 * Both targets are OPTIONAL and independent. A salesman may be given a sales
 * target and no collection target, or the reverse, or rates with no target at
 * all — the rates are what they are paid, the targets are only what they are
 * measured against, and a company that pays commission without setting targets
 * is normal.
 *
 * Cash and credit share ONE target because a sale is a sale to the person
 * selling it; they carry different RATES because the money arrives at different
 * times and carries different risk.
 *
 * `metric` and `target_value` are kept, not dropped. Existing rows are the only
 * record of what was set before, an AMOUNT target means exactly what the new
 * sales target means, and it is copied across rather than asked for again.
 */
export class CommissionTargets1726500000000 implements MigrationInterface {
  name = 'CommissionTargets1726500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Cash and credit are paid at different rates, so a mirrored ERP invoice has
    // to say which it was. Unknown ones are treated as CREDIT downstream — the
    // lower rate — because guessing in the salesman's favour is how commission
    // gets overpaid quietly.
    await queryRunner.query(
      `ALTER TABLE "erp_invoices" ADD COLUMN IF NOT EXISTS "payment_type" text`,
    );
    await queryRunner.query(`
      ALTER TABLE "sales_targets"
        ADD COLUMN IF NOT EXISTS "sales_target_fils"      bigint,
        ADD COLUMN IF NOT EXISTS "collection_target_fils" bigint,
        ADD COLUMN IF NOT EXISTS "cash_pct"       numeric(5,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "credit_pct"     numeric(5,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "collection_pct" numeric(5,2) NOT NULL DEFAULT 0
    `);

    // An AMOUNT target already meant "sell this much", so it becomes the sales
    // target rather than being re-entered. A QTY target has no equivalent here
    // and is deliberately left where it is.
    await queryRunner.query(`
      UPDATE "sales_targets"
         SET "sales_target_fils" = "target_value"
       WHERE "metric" = 'AMOUNT'
         AND "sales_target_fils" IS NULL
         AND "target_value" IS NOT NULL
    `);

    // A row may now exist for its rates alone, or for a collection target with
    // no sales target, so the old pair can no longer be required.
    await queryRunner.query(`ALTER TABLE "sales_targets" ALTER COLUMN "target_value" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "sales_targets" ALTER COLUMN "metric" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the NOT NULLs the only way that cannot fail: give the rows that
    // have no old-style target a zero one before demanding it.
    await queryRunner.query(`UPDATE "sales_targets" SET "target_value" = COALESCE("target_value", "sales_target_fils", 0)`);
    await queryRunner.query(`UPDATE "sales_targets" SET "metric" = COALESCE("metric", 'AMOUNT')`);
    await queryRunner.query(`ALTER TABLE "sales_targets" ALTER COLUMN "target_value" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "sales_targets" ALTER COLUMN "metric" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "erp_invoices" DROP COLUMN IF EXISTS "payment_type"`);
    await queryRunner.query(`
      ALTER TABLE "sales_targets"
        DROP COLUMN IF EXISTS "collection_pct",
        DROP COLUMN IF EXISTS "credit_pct",
        DROP COLUMN IF EXISTS "cash_pct",
        DROP COLUMN IF EXISTS "collection_target_fils",
        DROP COLUMN IF EXISTS "sales_target_fils"
    `);
  }
}
