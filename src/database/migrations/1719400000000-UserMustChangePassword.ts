import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Force-change flag for auto-provisioned salesman logins. New salesmen get a
 * fixed default password and must set their own on first login.
 */
export class UserMustChangePassword1719400000000 implements MigrationInterface {
  name = 'UserMustChangePassword1719400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "must_change_password" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "must_change_password"
    `);
  }
}
