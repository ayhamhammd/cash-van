import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A per-salesman commission rate, for the printable rep commission report.
 *
 * numeric(5,2) holds 0.00–100.00 — a percentage, not a fraction. Default 0 so
 * no existing rep is suddenly owed commission on upgrade; the office sets a
 * rate per rep when they want one. The CHECK keeps a fat-fingered 1000 out.
 */
export class RepCommission1724100000000 implements MigrationInterface {
  name = 'RepCommission1724100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reps" ADD COLUMN IF NOT EXISTS "commission_pct" numeric(5,2) NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_reps_commission_pct'
        ) THEN
          ALTER TABLE "reps" ADD CONSTRAINT "chk_reps_commission_pct"
            CHECK ("commission_pct" BETWEEN 0 AND 100);
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reps" DROP CONSTRAINT IF EXISTS "chk_reps_commission_pct"`,
    );
    await queryRunner.query(`ALTER TABLE "reps" DROP COLUMN IF EXISTS "commission_pct"`);
  }
}
