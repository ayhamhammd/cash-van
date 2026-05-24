import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Journey Plan (PJP) — the recurring per-outlet visit schedule that drives
 * daily route generation.
 *
 * One row = one shop a rep serves + the weekdays it should be visited.
 *   - weekdays: 0=Sunday .. 6=Saturday (matches Postgres EXTRACT(DOW) / JS getDay)
 *   - "Daily" = every working weekday selected; "Weekly (Tue)" = [2];
 *     "2x/week (Sun+Wed)" = [0,3]. (Fortnightly/monthly cycles intentionally
 *     out of scope for this build.)
 *
 * Daily route generation pulls the outlets whose weekdays include the target
 * date's day-of-week; the existing route_plans / route_stops stay as the daily
 * materialized output.
 */
export class AddJourneyPlanEntries1716800000000 implements MigrationInterface {
  name = 'AddJourneyPlanEntries1716800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "journey_plan_entries" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "rep_id"      UUID NOT NULL REFERENCES "reps"("id") ON DELETE CASCADE,
        "customer_id" UUID NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
        "weekdays"    SMALLINT[] NOT NULL,
        "is_active"   BOOLEAN NOT NULL DEFAULT true,
        "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "uq_journey_plan_rep_customer" UNIQUE ("rep_id", "customer_id"),
        CONSTRAINT "ck_journey_plan_weekdays" CHECK (
          array_length("weekdays", 1) BETWEEN 1 AND 7
          AND "weekdays" <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_journey_plan_rep_active" ON "journey_plan_entries" ("rep_id", "is_active")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_journey_plan_customer" ON "journey_plan_entries" ("customer_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "journey_plan_entries"`);
  }
}
