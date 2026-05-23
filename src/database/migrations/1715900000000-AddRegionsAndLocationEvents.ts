import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plan 02 — Territories & Geography.
 *
 *  - `regions`: GeoJSON polygon territories. JSONB; validation is app-side
 *    (no PostGIS dependency).
 *  - `rep_location_events`: GPS pings, range-partitioned monthly by
 *    `recorded_at` so old months can be dropped cheaply.
 *  - FKs `reps.region_id` and `users.region_id` → `regions(id)` (added now
 *    because plan 01 created the columns before this table existed).
 */
export class AddRegionsAndLocationEvents1715900000000 implements MigrationInterface {
  name = 'AddRegionsAndLocationEvents1715900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- regions -----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "regions" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name_ar"    TEXT NOT NULL,
        "name_en"    TEXT,
        "boundary"   JSONB,
        "is_active"  BOOLEAN NOT NULL DEFAULT TRUE,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMPTZ,
        "version"    INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "ck_regions_boundary_polygon"
          CHECK ("boundary" IS NULL OR "boundary"->>'type' = 'Polygon')
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_regions_is_active" ON "regions" ("is_active")`);

    // ---- reps.region_id and users.region_id FKs ----------------------------
    await queryRunner.query(`
      ALTER TABLE "reps"
        ADD CONSTRAINT "fk_reps_region_id"
        FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD CONSTRAINT "fk_users_region_id"
        FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE SET NULL
    `);

    // ---- rep_location_events (parent + first partitions) -------------------
    await queryRunner.query(`
      CREATE TABLE "rep_location_events" (
        "id"          BIGSERIAL,
        "rep_id"      UUID NOT NULL REFERENCES "reps"("id") ON DELETE CASCADE,
        "lat"         DOUBLE PRECISION NOT NULL,
        "lng"         DOUBLE PRECISION NOT NULL,
        "accuracy_m"  REAL,
        "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("id", "recorded_at")
      ) PARTITION BY RANGE ("recorded_at")
    `);

    // Indexes on the parent — automatically created on every partition.
    await queryRunner.query(`
      CREATE INDEX "idx_rle_rep_recorded_desc" ON "rep_location_events" ("rep_id", "recorded_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_rle_recorded_desc" ON "rep_location_events" ("recorded_at" DESC)
    `);

    // Current month + next month partitions, plus a DEFAULT catch-all so a
    // late ping never errors. (The cron auto-creates future months on the 25th.)
    const now = new Date();
    const cur = monthRange(now);
    const nxt = monthRange(addMonths(now, 1));

    await queryRunner.query(`
      CREATE TABLE "${cur.tableName}" PARTITION OF "rep_location_events"
        FOR VALUES FROM ('${cur.from}') TO ('${cur.to}')
    `);
    await queryRunner.query(`
      CREATE TABLE "${nxt.tableName}" PARTITION OF "rep_location_events"
        FOR VALUES FROM ('${nxt.from}') TO ('${nxt.to}')
    `);
    await queryRunner.query(`
      CREATE TABLE "rep_location_events_default" PARTITION OF "rep_location_events" DEFAULT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "rep_location_events" CASCADE`);
    await queryRunner.query(`
      ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "fk_users_region_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "reps" DROP CONSTRAINT IF EXISTS "fk_reps_region_id"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "regions"`);
  }
}

// Helpers — kept inside the migration file so they don't leak into prod code.
function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function monthRange(d: Date): { tableName: string; from: string; to: string } {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1; // 1-12
  const mm = String(month).padStart(2, '0');
  const from = `${year}-${mm}-01`;
  const next = addMonths(d, 1);
  const to = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
  return {
    tableName: `rep_location_events_${year}${mm}`,
    from,
    to,
  };
}
