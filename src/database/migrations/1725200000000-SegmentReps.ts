import { MigrationInterface, QueryRunner } from 'typeorm';

/** segment_reps: which salesmen serve a segment (phase 4 rep linking). */
export class SegmentReps1725200000000 implements MigrationInterface {
  name = 'SegmentReps1725200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "segment_reps" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        "deleted_at"  timestamptz,
        "version"     integer NOT NULL DEFAULT 1,
        "segment_id"  uuid NOT NULL REFERENCES "customer_segments"("id") ON DELETE CASCADE,
        "rep_id"      uuid NOT NULL REFERENCES "reps"("id") ON DELETE CASCADE,
        "added_by"    uuid,
        "added_at"    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_segment_reps_pair" ON "segment_reps" ("segment_id", "rep_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_segment_reps_segment" ON "segment_reps" ("segment_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "segment_reps"`);
  }
}
