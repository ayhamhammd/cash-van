import { MigrationInterface, QueryRunner } from 'typeorm';

/** Developer / support accounts that skip sign-in device approval. Off for everyone. */
export class AnyDeviceUsers1728300000000 implements MigrationInterface {
  name = 'AnyDeviceUsers1728300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS skip_device_approval boolean NOT NULL DEFAULT false`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE users DROP COLUMN IF EXISTS skip_device_approval`);
  }
}
