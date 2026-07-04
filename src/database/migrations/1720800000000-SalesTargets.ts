import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-salesman monthly sales targets (on sale AMOUNT in fils, or sale QTY). */
export class SalesTargets1720800000000 implements MigrationInterface {
  name = 'SalesTargets1720800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sales_targets" (
        "id"           uuid NOT NULL DEFAULT uuid_generate_v4(),
        "rep_id"       uuid NOT NULL,
        "year"         integer NOT NULL,
        "month"        integer NOT NULL,
        "metric"       text NOT NULL DEFAULT 'AMOUNT',
        "target_value" bigint NOT NULL,
        "notes"        text,
        "created_at"   timestamptz NOT NULL DEFAULT now(),
        "updated_at"   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_sales_targets" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_sales_target_rep_period" ON "sales_targets" ("rep_id", "year", "month")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sales_targets"`);
  }
}
