import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rep-scoped dashboard users — see docs/SPEC-rep-scoped-users.md.
 *
 * A supervisor owns a subset of the field force and must see only their own
 * salesmen. `rep_scope_mode` says whether this user is restricted at all;
 * `user_rep_scope` says to whom.
 *
 * The default is 'all' so every existing user keeps the access they have today —
 * scoping only takes effect when someone is deliberately switched to 'assigned'.
 */
export class RepScopedUsers1722900000000 implements MigrationInterface {
  name = 'RepScopedUsers1722900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "users"
        ADD COLUMN "rep_scope_mode" text NOT NULL DEFAULT 'all'`);

    // Guard the only two legal values in the database, not just the DTO: a bad
    // value here would silently fall through to "unrestricted" in the resolver.
    await q.query(`
      ALTER TABLE "users"
        ADD CONSTRAINT "users_rep_scope_mode_check"
        CHECK ("rep_scope_mode" IN ('all', 'assigned'))`);

    await q.query(`
      CREATE TABLE "user_rep_scope" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "rep_id"     uuid NOT NULL REFERENCES "reps"("id")  ON DELETE CASCADE,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);

    // Assigning the same rep twice is a UI double-submit, not an intent.
    await q.query(`
      CREATE UNIQUE INDEX "uq_user_rep_scope"
        ON "user_rep_scope" ("user_id", "rep_id")`);

    // The hot path: "which reps may this user see", run on nearly every request
    // a scoped user makes.
    await q.query(`
      CREATE INDEX "idx_user_rep_scope_user"
        ON "user_rep_scope" ("user_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "user_rep_scope"`);
    await q.query(`
      ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_rep_scope_mode_check"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN "rep_scope_mode"`);
  }
}
