import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plan 01 — Auth, Reps, App Settings.
 *
 * - Adds the `reps` table (field workforce, separate from `users`).
 * - Adds the `app_settings` single-row table (CHECK id = 1) for company-wide
 *   config: seller TIN, JoFotara credentials (encrypted), AI quotas, locale.
 * - Extends `users` with email/name_ar/name_en/role/region_id/avatar_url/last_login_at.
 */
export class AddRepsAndAppSettings1715800000000 implements MigrationInterface {
  name = 'AddRepsAndAppSettings1715800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- app_settings (single row) -----------------------------------------
    await queryRunner.query(`
      CREATE TABLE "app_settings" (
        "id"                            SMALLINT PRIMARY KEY DEFAULT 1,
        "company_name_ar"               TEXT NOT NULL DEFAULT 'My Company',
        "company_name_en"               TEXT,
        "seller_tin"                    TEXT,
        "seller_address"                TEXT,
        "seller_phone"                  TEXT,
        "seller_city_code"              TEXT,
        "timezone"                      TEXT NOT NULL DEFAULT 'Asia/Amman',
        "locale"                        TEXT NOT NULL DEFAULT 'ar',
        "ai_chat_quota"                 INTEGER NOT NULL DEFAULT 200,
        "ai_infer_quota"                INTEGER NOT NULL DEFAULT 1000,
        "jofotara_client_id"            TEXT,
        "jofotara_secret_key_encrypted" TEXT,
        "jofotara_secret_last4"         TEXT,
        "jofotara_sandbox"              BOOLEAN NOT NULL DEFAULT TRUE,
        "updated_at"                    TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_by"                    UUID,
        CONSTRAINT "ck_app_settings_single_row" CHECK ("id" = 1)
      )
    `);
    // Seed the single row.
    await queryRunner.query(`
      INSERT INTO "app_settings" ("id") VALUES (1)
    `);

    // ---- users extension ---------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN "email"         TEXT,
        ADD COLUMN "name_ar"       TEXT,
        ADD COLUMN "name_en"       TEXT,
        ADD COLUMN "role"          TEXT NOT NULL DEFAULT 'viewer',
        ADD COLUMN "region_id"     UUID,
        ADD COLUMN "avatar_url"    TEXT,
        ADD COLUMN "last_login_at" TIMESTAMPTZ
    `);
    // Backfill name_ar from existing `name`.
    await queryRunner.query(`UPDATE "users" SET "name_ar" = "name" WHERE "name_ar" IS NULL`);
    // Map existing user_type → role.
    await queryRunner.query(`
      UPDATE "users" SET "role" = CASE
        WHEN "user_type" = 'ADMIN'   THEN 'admin'
        WHEN "user_type" = 'MANAGER' THEN 'manager'
        ELSE 'viewer'
      END
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD CONSTRAINT "ck_users_role" CHECK ("role" IN ('admin','manager','supervisor','viewer'))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_users_email" ON "users" ("email") WHERE "email" IS NOT NULL
    `);

    // ---- reps --------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "reps" (
        "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"          UUID REFERENCES "users"("id") ON DELETE SET NULL,
        "name_ar"          TEXT NOT NULL,
        "name_en"          TEXT,
        "phone"            TEXT,
        "region_id"        UUID,
        "van_id"           UUID,
        "is_active"        BOOLEAN NOT NULL DEFAULT TRUE,
        "hire_date"        DATE,
        "daily_quota_fils" INTEGER,
        "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"       TIMESTAMPTZ,
        "version"          INTEGER NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_reps_is_active" ON "reps" ("is_active")`);
    await queryRunner.query(`CREATE INDEX "idx_reps_region_id" ON "reps" ("region_id")`);
    await queryRunner.query(`
      CREATE INDEX "idx_reps_user_id" ON "reps" ("user_id") WHERE "user_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "reps"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_users_email"`);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "ck_users_role"`);
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "email",
        DROP COLUMN IF EXISTS "name_ar",
        DROP COLUMN IF EXISTS "name_en",
        DROP COLUMN IF EXISTS "role",
        DROP COLUMN IF EXISTS "region_id",
        DROP COLUMN IF EXISTS "avatar_url",
        DROP COLUMN IF EXISTS "last_login_at"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "app_settings"`);
  }
}
