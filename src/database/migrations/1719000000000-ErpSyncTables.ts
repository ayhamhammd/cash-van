import { MigrationInterface, QueryRunner } from 'typeorm';

/** ERP inbound sync bookkeeping: id mapping + per-entity pull cursor. */
export class ErpSyncTables1719000000000 implements MigrationInterface {
  name = 'ErpSyncTables1719000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "erp_id_map" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "entity" text NOT NULL,
        "erp_id" text NOT NULL,
        "erp_code" text,
        "local_id" text NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_erp_id_map" PRIMARY KEY ("id"),
        CONSTRAINT "uq_erp_id_map_entity_erp" UNIQUE ("entity", "erp_id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "erp_sync_cursor" (
        "entity" text NOT NULL,
        "updated_since" timestamptz,
        "last_run_at" timestamptz,
        "last_status" text,
        "last_count" integer NOT NULL DEFAULT 0,
        "last_error" text,
        CONSTRAINT "pk_erp_sync_cursor" PRIMARY KEY ("entity")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "erp_sync_cursor"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "erp_id_map"`);
  }
}
