import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The Google Maps browser key, moved out of the image and into settings.
 *
 * It was a build-time NEXT_PUBLIC_ value patched at container start, which meant
 * rotating it needed someone with shell access on each server. Stored here, an
 * admin rotates it from the Settings screen and it applies on the next page load.
 *
 * Encrypted like the other stored keys even though this one is handed to the
 * browser by design — the protection that matters for a Maps key is the
 * HTTP-referrer restriction in Google Cloud, but there is no reason to keep it
 * in plaintext in a backup either.
 */
export class GoogleMapsKey1726800000000 implements MigrationInterface {
  name = 'GoogleMapsKey1726800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "google_maps_api_key_encrypted" text`,
    );
    await q.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "google_maps_api_key_last4" text`,
    );
    await q.query(
      `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "google_maps_map_id" text`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "google_maps_map_id"`);
    await q.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "google_maps_api_key_last4"`);
    await q.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "google_maps_api_key_encrypted"`);
  }
}
