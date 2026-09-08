import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Item photos, cached here and served from here.
 *
 * TWO FAILURES, ONE FIX.
 *
 * The ERP used to write photos to its container's own filesystem, so every
 * deploy destroyed them while the rows kept pointing at them. That is fixed on
 * the ERP side — they live in its database now.
 *
 * This is the second failure, and it survives that fix. The item's image URL was
 * built by gluing the ERP's CONFIGURED base URL onto a relative path, and that
 * base is whatever makes the server-to-server sync work — commonly an address
 * only reachable inside the docker network, or a private one. A van's phone
 * cannot resolve it, so the image 404s on the handset while looking perfectly
 * fine in the office.
 *
 * The phone already talks to this server and can always reach it. So the bytes
 * are cached here and served from here, and the handset never needs to reach the
 * ERP at all.
 *
 * Filled on FIRST REQUEST, not during the sync: an item catalogue is thousands
 * of rows and only some are ever looked at, so fetching every photo on every
 * sync would spend most of its effort on images nobody opens. A miss costs one
 * server-to-server fetch, once, and heals itself.
 */
export class ItemImages1726600000000 implements MigrationInterface {
  name = 'ItemImages1726600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "item_images" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        "version"    integer NOT NULL DEFAULT 1,
        "item_id"    uuid NOT NULL REFERENCES "item_cart"("id") ON DELETE CASCADE,
        -- What this copy was taken from. When the item's image url changes the
        -- cached bytes are stale, and comparing this is how that is noticed.
        "source_url" text NOT NULL,
        "data"       bytea NOT NULL,
        "thumb"      bytea,
        "mime"       text NOT NULL,
        "byte_size"  integer NOT NULL,
        "fetched_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_item_images_item" ON "item_images" ("item_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "item_images"`);
  }
}
