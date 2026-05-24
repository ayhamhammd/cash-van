import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Carry-forward support for missed visits.
 *
 * `carried_over` marks a stop that landed on a day's route NOT because it was
 * scheduled that day, but because it was missed on an earlier day and rolled
 * forward ("overdue"). "Missed" itself is computed on read (a past-dated stop
 * still in 'pending'), so no status column / nightly job is added.
 */
export class AddRouteStopCarriedOver1716900000000 implements MigrationInterface {
  name = 'AddRouteStopCarriedOver1716900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "route_stops" ADD COLUMN "carried_over" BOOLEAN NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "route_stops" DROP COLUMN IF EXISTS "carried_over"`,
    );
  }
}
