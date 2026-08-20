import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widen the route cycle ceiling from 60 to 100 days.
 *
 * A CHECK constraint cannot be altered in place, so both are dropped and
 * re-added. Widening is unconditionally safe in the `up` direction: every row
 * that satisfied `<= 60` satisfies `<= 100`, so there is nothing to validate
 * and no data to migrate.
 *
 * The reverse is NOT safe, which is why `down` narrows the plans first. A rep
 * left on a 90-day cycle would make the re-added constraint un-addable, and
 * an entry sitting on day 74 would have no valid home under a 60-day rule.
 *
 * Per-rep validation is unaffected: JourneyPlanService.validDays() bounds each
 * day index to that rep's own cycle length, so a 14-day rep still cannot be
 * given day 40. These constraints are only the outer envelope.
 */
export class RouteCycleTo1001723800000000 implements MigrationInterface {
  name = 'RouteCycleTo1001723800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reps" DROP CONSTRAINT IF EXISTS "chk_reps_route_cycle_days"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reps" ADD CONSTRAINT "chk_reps_route_cycle_days"
         CHECK ("route_cycle_days" BETWEEN 1 AND 100)`,
    );

    await queryRunner.query(
      `ALTER TABLE "journey_plan_entries" DROP CONSTRAINT IF EXISTS "ck_journey_plan_cycle_days"`,
    );
    await queryRunner.query(
      `ALTER TABLE "journey_plan_entries" ADD CONSTRAINT "ck_journey_plan_cycle_days"
         CHECK (
           array_length("cycle_days", 1) BETWEEN 1 AND 100
           AND 0 <= ALL("cycle_days")
           AND 100 > ALL("cycle_days")
         )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Bring any cycle longer than 60 back inside the old ceiling before the
    // narrower constraint is re-applied, or the ALTER fails outright.
    await queryRunner.query(
      `UPDATE "reps" SET "route_cycle_days" = 60 WHERE "route_cycle_days" > 60`,
    );
    await queryRunner.query(
      `UPDATE "journey_plan_entries"
          SET "cycle_days" = ARRAY(SELECT d FROM unnest("cycle_days") d WHERE d < 60)
        WHERE EXISTS (SELECT 1 FROM unnest("cycle_days") d WHERE d >= 60)`,
    );
    await queryRunner.query(
      `DELETE FROM "journey_plan_entries" WHERE cardinality("cycle_days") = 0`,
    );

    await queryRunner.query(
      `ALTER TABLE "reps" DROP CONSTRAINT IF EXISTS "chk_reps_route_cycle_days"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reps" ADD CONSTRAINT "chk_reps_route_cycle_days"
         CHECK ("route_cycle_days" BETWEEN 1 AND 60)`,
    );
    await queryRunner.query(
      `ALTER TABLE "journey_plan_entries" DROP CONSTRAINT IF EXISTS "ck_journey_plan_cycle_days"`,
    );
    await queryRunner.query(
      `ALTER TABLE "journey_plan_entries" ADD CONSTRAINT "ck_journey_plan_cycle_days"
         CHECK (
           array_length("cycle_days", 1) BETWEEN 1 AND 60
           AND 0 <= ALL("cycle_days")
           AND 60 > ALL("cycle_days")
         )`,
    );
  }
}
