import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-rep liveness state (1:1 with reps). Kept off the reps master-data table
 * because heartbeats/location pings touch `last_seen_at` every ~60s per rep.
 *
 * The rep-offline watchdog reads `last_seen_at` here (single indexed query);
 * `offline_alerted_at` / `gps_alerted_at` persist alert dedup so a redeploy
 * doesn't replay a storm of offline alerts.
 */
export class RepStatusHeartbeat1720200000000 implements MigrationInterface {
  name = 'RepStatusHeartbeat1720200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rep_statuses" (
        "rep_id" uuid NOT NULL,
        "last_seen_at" timestamptz,
        "gps_enabled" boolean,
        "last_app_state" text NOT NULL DEFAULT 'active',
        "battery_pct" integer,
        "offline_alerted_at" timestamptz,
        "gps_alerted_at" timestamptz,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_rep_statuses" PRIMARY KEY ("rep_id"),
        CONSTRAINT "fk_rep_statuses_rep" FOREIGN KEY ("rep_id") REFERENCES "reps"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_rep_statuses_last_seen" ON "rep_statuses" ("last_seen_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "rep_statuses"`);
  }
}
