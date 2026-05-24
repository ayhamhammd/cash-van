import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enforce a 1:1 link between a dashboard `users` row and a field `reps` row.
 *
 * Before this, `reps.user_id` had a plain (non-unique) partial index, so nothing
 * stopped two reps pointing at the same user — which makes "resolve the rep for
 * the logged-in user" ambiguous. We replace it with a UNIQUE partial index
 * (NULLs still allowed and unconstrained, so unlinked reps remain fine).
 */
export class MakeRepUserIdUnique1716700000000 implements MigrationInterface {
  name = 'MakeRepUserIdUnique1716700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_reps_user_id"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_reps_user_id" ON "reps" ("user_id") WHERE "user_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_reps_user_id"`);
    await queryRunner.query(
      `CREATE INDEX "idx_reps_user_id" ON "reps" ("user_id") WHERE "user_id" IS NOT NULL`,
    );
  }
}
