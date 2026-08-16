import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Route cycles of any length, replacing the fixed 7-day week.
 *
 * A journey plan used to say "visit this outlet on Sunday and Wednesday", and
 * the due date was derived from the calendar alone — `getUTCDay()` of the date.
 * That only works for a 7-day rhythm. "Every 14 days" cannot be read off a date
 * at all: day 3 of a fortnight is only meaningful relative to a fixed starting
 * point, so each rep now carries an anchor as well as a length.
 *
 *   cycleIndex = (date - anchor) mod cycleDays
 *
 * WHY THIS IS BEHAVIOUR-NEUTRAL ON UPGRADE: with cycleDays = 7 and an anchor
 * that falls on a Sunday, that expression is *identically* getUTCDay(). So the
 * existing rows need no transformation — 0 still means Sunday, 3 still means
 * Wednesday, and every plan comes due on exactly the day it did before. The
 * anchor is a fixed historical Sunday rather than "the most recent Sunday" so
 * the backfill is deterministic and re-runnable.
 *
 * The column rename is the honest part: these are no longer weekdays. For a
 * 14-day cycle the values run 0..13 and "Monday" appears twice, so a name that
 * says `weekdays` would be actively misleading to the next reader.
 */
export class RouteCycle1723700000000 implements MigrationInterface {
  name = 'RouteCycle1723700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reps" ADD COLUMN IF NOT EXISTS "route_cycle_days" smallint NOT NULL DEFAULT 7`,
    );
    // 2024-01-07 is a Sunday. Any Sunday gives the same result (the maths is
    // mod 7); a constant one keeps the migration deterministic.
    await queryRunner.query(
      `ALTER TABLE "reps" ADD COLUMN IF NOT EXISTS "route_cycle_anchor" date NOT NULL DEFAULT DATE '2024-01-07'`,
    );
    // NULL ⇒ the UI shows "N days". A name is only worth storing when the
    // client calls the cycle something of their own.
    await queryRunner.query(
      `ALTER TABLE "reps" ADD COLUMN IF NOT EXISTS "route_cycle_name" text`,
    );

    // A cycle of 0 would divide by zero; an unbounded one would let a typo of
    // "365" quietly park every outlet a year out.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_reps_route_cycle_days'
        ) THEN
          ALTER TABLE "reps" ADD CONSTRAINT "chk_reps_route_cycle_days"
            CHECK ("route_cycle_days" BETWEEN 1 AND 60);
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'journey_plan_entries' AND column_name = 'weekdays'
        ) THEN
          ALTER TABLE "journey_plan_entries" RENAME COLUMN "weekdays" TO "cycle_days";
        END IF;
      END $$;
    `);

    // The original table carried CHECK (weekdays <@ ARRAY[0..6] AND length <= 7).
    // A rename does NOT relax it — it follows the column — so without this every
    // insert on a cycle longer than a week would be rejected by the database,
    // and the feature would fail at exactly the point it started being used.
    await queryRunner.query(
      `ALTER TABLE "journey_plan_entries" DROP CONSTRAINT IF EXISTS "ck_journey_plan_weekdays"`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'ck_journey_plan_cycle_days'
        ) THEN
          ALTER TABLE "journey_plan_entries" ADD CONSTRAINT "ck_journey_plan_cycle_days"
            CHECK (
              array_length("cycle_days", 1) BETWEEN 1 AND 60
              AND 0 <= ALL("cycle_days")
              AND 60 > ALL("cycle_days")
            );
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reversing is only safe for reps still on a 7-day cycle: a 14-day plan has
    // day indices 7..13 that no weekday column can hold. Those rows are dropped
    // rather than silently folded onto the wrong weekday.
    await queryRunner.query(`
      DELETE FROM "journey_plan_entries" e
       USING "reps" r
       WHERE r."id" = e."rep_id" AND r."route_cycle_days" <> 7
    `);
    await queryRunner.query(
      `ALTER TABLE "journey_plan_entries" DROP CONSTRAINT IF EXISTS "ck_journey_plan_cycle_days"`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'journey_plan_entries' AND column_name = 'cycle_days'
        ) THEN
          ALTER TABLE "journey_plan_entries" RENAME COLUMN "cycle_days" TO "weekdays";
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'ck_journey_plan_weekdays'
        ) THEN
          ALTER TABLE "journey_plan_entries" ADD CONSTRAINT "ck_journey_plan_weekdays"
            CHECK (
              array_length("weekdays", 1) BETWEEN 1 AND 7
              AND "weekdays" <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
            );
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `ALTER TABLE "reps" DROP CONSTRAINT IF EXISTS "chk_reps_route_cycle_days"`,
    );
    await queryRunner.query(`ALTER TABLE "reps" DROP COLUMN IF EXISTS "route_cycle_name"`);
    await queryRunner.query(`ALTER TABLE "reps" DROP COLUMN IF EXISTS "route_cycle_anchor"`);
    await queryRunner.query(`ALTER TABLE "reps" DROP COLUMN IF EXISTS "route_cycle_days"`);
  }
}
