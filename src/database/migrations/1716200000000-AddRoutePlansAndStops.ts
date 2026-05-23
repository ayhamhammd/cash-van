import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plan 05 — Route Plans & Stops.
 *
 *  - `route_plans`: one plan per rep per day (UNIQUE rep_id, plan_date).
 *  - `route_stops`: ordered customer stops with planned/actual times + status.
 *
 * Single-tenant — no tenant_id / RLS. Tables use explicit columns (no version).
 */
export class AddRoutePlansAndStops1716200000000 implements MigrationInterface {
  name = 'AddRoutePlansAndStops1716200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "route_plans" (
        "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "rep_id"          UUID NOT NULL REFERENCES "reps"("id") ON DELETE CASCADE,
        "plan_date"       DATE NOT NULL,
        "source"          TEXT NOT NULL DEFAULT 'manual',
        "ai_est_distance" REAL,
        "ai_est_duration" INTEGER,
        "ai_savings_min"  INTEGER,
        "accepted_at"     TIMESTAMPTZ,
        "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "uq_route_plans_rep_date" UNIQUE ("rep_id", "plan_date"),
        CONSTRAINT "ck_route_plans_source" CHECK ("source" IN ('manual','ai_optimized'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_route_plans_date" ON "route_plans" ("plan_date")`);
    await queryRunner.query(`
      CREATE INDEX "idx_route_plans_rep_date_desc" ON "route_plans" ("rep_id", "plan_date" DESC)
    `);

    await queryRunner.query(`
      CREATE TABLE "route_stops" (
        "id"               BIGSERIAL PRIMARY KEY,
        "plan_id"          UUID NOT NULL REFERENCES "route_plans"("id") ON DELETE CASCADE,
        "customer_id"      UUID NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
        "stop_order"       INTEGER NOT NULL,
        "est_arrival"      TIMESTAMPTZ,
        "est_duration_min" INTEGER NOT NULL DEFAULT 20,
        "actual_arrival"   TIMESTAMPTZ,
        "actual_departure" TIMESTAMPTZ,
        "status"           TEXT NOT NULL DEFAULT 'pending',
        "skip_reason"      TEXT,
        CONSTRAINT "ck_route_stops_status" CHECK ("status" IN ('pending','visited','skipped'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_route_stops_plan_order" ON "route_stops" ("plan_id", "stop_order")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_route_stops_customer_status" ON "route_stops" ("customer_id", "status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "route_stops"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "route_plans"`);
  }
}
