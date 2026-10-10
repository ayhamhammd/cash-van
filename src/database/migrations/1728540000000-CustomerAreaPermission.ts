import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The second switch on a salesman's new customer is the AREA, not the GPS pin.
 *
 * 1728530000000 added can_set_customer_location; what the office wanted was
 * control over which area (المنطقة) the salesman files the shop under, with the
 * GPS capture left as it always was. That migration may already have run, so
 * this one replaces the column rather than editing it.
 *
 * Off for everyone by default, like its sibling can_set_customer_segment.
 */
export class CustomerAreaPermission1728540000000 implements MigrationInterface {
  name = 'CustomerAreaPermission1728540000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS can_set_customer_area boolean NOT NULL DEFAULT false,
        DROP COLUMN IF EXISTS can_set_customer_location
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS can_set_customer_location boolean NOT NULL DEFAULT false,
        DROP COLUMN IF EXISTS can_set_customer_area
    `);
  }
}
