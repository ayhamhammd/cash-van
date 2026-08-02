import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supervisor scoping, phase 1 — the assignment table only.
 *
 * See docs/SPEC-supervisor-scoping.md. This migration is additive and changes
 * no behaviour on its own: with the table empty every user resolves exactly as
 * they do today (admin -> ALL, everyone else unaffected until the enforcement
 * sweep lands).
 *
 * A join table rather than a column on `reps`, because a rep may later need
 * more than one supervisor (cover, handover, regional + segment). Many-to-many
 * now costs nothing and avoids a second migration later.
 *
 * ON DELETE CASCADE on both sides: deleting a user or a rep drops the
 * assignment instead of leaving a dangling row that silently widens or narrows
 * someone's scope.
 *
 * No soft-delete column, deliberately. Unassigning is a hard delete, so
 * re-assigning the same rep later cannot collide with an invisible
 * soft-deleted row through uq_supervisor_rep.
 */
export class SupervisorReps1722000000000 implements MigrationInterface {
  name = 'SupervisorReps1722000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "supervisor_reps" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "rep_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" uuid,
        CONSTRAINT "pk_supervisor_reps" PRIMARY KEY ("id"),
        CONSTRAINT "uq_supervisor_rep" UNIQUE ("user_id", "rep_id"),
        CONSTRAINT "fk_supervisor_reps_user_id" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_supervisor_reps_rep_id" FOREIGN KEY ("rep_id")
          REFERENCES "reps"("id") ON DELETE CASCADE
      )
    `);

    // Scope resolution reads every row for one user, once per request.
    await queryRunner.query(
      `CREATE INDEX "idx_supervisor_reps_user" ON "supervisor_reps" ("user_id")`,
    );
    // Reverse lookup: "who supervises this rep?" for the assignment UI.
    await queryRunner.query(
      `CREATE INDEX "idx_supervisor_reps_rep" ON "supervisor_reps" ("rep_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "supervisor_reps"`);
  }
}
