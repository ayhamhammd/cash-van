import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-customer file attachments (documents, scans, data sheets). */
export class CustomerAttachments1718400000000 implements MigrationInterface {
  name = 'CustomerAttachments1718400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "customer_attachments" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "customer_id"   uuid NOT NULL,
        "storage_key"   text NOT NULL,
        "url"           text NOT NULL,
        "original_name" text NOT NULL,
        "mime_type"     text NOT NULL,
        "size_bytes"    integer NOT NULL DEFAULT 0,
        "uploaded_by"   uuid,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_customer_attachments_customer"
          FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_customer_attachments_customer"
         ON "customer_attachments" ("customer_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_customer_attachments_customer"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_attachments"`);
  }
}
