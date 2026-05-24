import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plan 13 — Frontend BFF support fields.
 *
 *  - reps.code      : human salesman code (e.g. "S012") the mobile contract keys on.
 *  - regions.code   : human route code (e.g. "R-A01").
 *  - app_settings.company_number : single-tenant company id echoed/validated by the BFF.
 *  - app_settings.logo_url       : company logo URL for /company/meta.
 */
export class AddFrontendBffFields1717000000000 implements MigrationInterface {
  name = 'AddFrontendBffFields1717000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "reps" ADD COLUMN "code" TEXT`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_reps_code" ON "reps" ("code") WHERE "code" IS NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "regions" ADD COLUMN "code" TEXT`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_regions_code" ON "regions" ("code") WHERE "code" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_settings" ADD COLUMN "company_number" TEXT NOT NULL DEFAULT 'C001'`,
    );
    await queryRunner.query(`ALTER TABLE "app_settings" ADD COLUMN "logo_url" TEXT`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "logo_url"`);
    await queryRunner.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "company_number"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_regions_code"`);
    await queryRunner.query(`ALTER TABLE "regions" DROP COLUMN IF EXISTS "code"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_reps_code"`);
    await queryRunner.query(`ALTER TABLE "reps" DROP COLUMN IF EXISTS "code"`);
  }
}
