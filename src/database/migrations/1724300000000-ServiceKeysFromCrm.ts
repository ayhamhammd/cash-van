import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Somewhere to put the keys the CRM sets for us.
 *
 * The AI key and the JoFotara credentials already had a home here — they were
 * typed on the settings screen. The Google Maps key did not: it was baked into
 * the dashboard build, which meant one key for every customer, no way to tell
 * whose usage was whose, and a rebuild to change it.
 *
 * `ai_key_source` is the one worth explaining. A company can be on its own AI
 * key, on ours, or on none at all, and the difference is who gets the bill. It
 * has to be recorded rather than inferred from "is there a key here", because
 * "on the platform key" and "on no key" look identical from that angle and cost
 * very different amounts.
 */
export class ServiceKeysFromCrm1724300000000 implements MigrationInterface {
  name = 'ServiceKeysFromCrm1724300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "app_settings"
        ADD COLUMN IF NOT EXISTS "google_maps_key_encrypted" TEXT,
        ADD COLUMN IF NOT EXISTS "google_maps_key_last4"     TEXT,
        ADD COLUMN IF NOT EXISTS "ai_key_source"             TEXT NOT NULL DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS "keys_set_at"               TIMESTAMPTZ
    `);

    // A company that already had an AI key typed in on the settings screen was,
    // by definition, on its own key. Saying 'none' would tell the CRM this
    // customer has no AI and quietly hide screens they were using this morning.
    await q.query(`
      UPDATE "app_settings"
         SET "ai_key_source" = 'company'
       WHERE "ai_api_key_encrypted" IS NOT NULL
    `);

    await q.query(`
      ALTER TABLE "app_settings"
        ADD CONSTRAINT "ck_app_settings_ai_key_source"
        CHECK ("ai_key_source" IN ('company','platform','none'))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "app_settings"
        DROP CONSTRAINT IF EXISTS "ck_app_settings_ai_key_source"
    `);
    await q.query(`
      ALTER TABLE "app_settings"
        DROP COLUMN IF EXISTS "google_maps_key_encrypted",
        DROP COLUMN IF EXISTS "google_maps_key_last4",
        DROP COLUMN IF EXISTS "ai_key_source",
        DROP COLUMN IF EXISTS "keys_set_at"
    `);
  }
}
