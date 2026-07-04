import { MigrationInterface, QueryRunner } from 'typeorm';

/** Granular dashboard permission keys per user. */
export class UserPermissions1718300000000 implements MigrationInterface {
  name = 'UserPermissions1718300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "permissions" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "permissions"`);
  }
}
