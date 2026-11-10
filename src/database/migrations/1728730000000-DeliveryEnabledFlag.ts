import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The master switch for Delivery & collection (Program features).
 *
 * Off: the dashboard's delivery screens answer FEATURE_DISABLED, the phone's
 * delivery lists come back empty, and the sub-flags (increase requests, proof
 * required) keep their stored values but have no effect. Results a phone has
 * already saved are still accepted, and the ERP mirror keeps running.
 *
 * The starting value is decided from what the install already does: on where
 * delivery is in use (any mirrored delivery run, or any active rep who
 * delivers), off everywhere else. A new install starts off.
 */
export class DeliveryEnabledFlag1728730000000 implements MigrationInterface {
  name = 'DeliveryEnabledFlag1728730000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "delivery_enabled" boolean NOT NULL DEFAULT false`,
    );
    await q.query(`
      UPDATE "app_settings"
         SET "delivery_enabled" = (
               EXISTS (SELECT 1 FROM "delivery_runs")
            OR EXISTS (SELECT 1 FROM "reps"
                        WHERE "kind" IN ('DELIVERY', 'BOTH') AND "deleted_at" IS NULL))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "delivery_enabled"`);
  }
}
