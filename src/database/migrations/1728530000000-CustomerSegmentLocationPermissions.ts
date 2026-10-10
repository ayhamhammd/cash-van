import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Whether a salesman may choose the segment, and capture the GPS location, of a
 * customer they create from the app.
 *
 * Off for everyone by default, existing salesmen included — by request. The
 * office turns each one on per salesman from the dashboard; until then the app
 * hides the two sections and the server drops the fields if they arrive anyway.
 */
export class CustomerSegmentLocationPermissions1728530000000 implements MigrationInterface {
  name = 'CustomerSegmentLocationPermissions1728530000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS can_set_customer_segment boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS can_set_customer_location boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS can_set_customer_segment,
        DROP COLUMN IF EXISTS can_set_customer_location
    `);
  }
}
