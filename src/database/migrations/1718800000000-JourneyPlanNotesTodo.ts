import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the per-trip admin note + salesman to-do (and ordering / completion
 * tracking) to recurring journey-plan entries.
 */
export class JourneyPlanNotesTodo1718800000000 implements MigrationInterface {
  name = 'JourneyPlanNotesTodo1718800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "journey_plan_entries"
        ADD COLUMN IF NOT EXISTS "note" text,
        ADD COLUMN IF NOT EXISTS "todo" text,
        ADD COLUMN IF NOT EXISTS "sort_order" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "todo_done_date" date
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "journey_plan_entries"
        DROP COLUMN IF EXISTS "todo_done_date",
        DROP COLUMN IF EXISTS "sort_order",
        DROP COLUMN IF EXISTS "todo",
        DROP COLUMN IF EXISTS "note"
    `);
  }
}
