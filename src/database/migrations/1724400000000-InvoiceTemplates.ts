import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Designed print layouts (Template Designer). One row per template; the
 * designer's zone/element JSON lives in `layout`. `branch_id` NULL is a global
 * template — Postgres treats NULLs as distinct in the unique index, so several
 * global templates per document type may coexist and `is_default` picks one.
 */
export class InvoiceTemplates1724400000000 implements MigrationInterface {
  name = 'InvoiceTemplates1724400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "invoice_templates" (
        "id"            uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name"          text NOT NULL,
        "document_type" text NOT NULL,
        "paper_size"    text NOT NULL DEFAULT 'A4',
        "is_default"    boolean NOT NULL DEFAULT false,
        "branch_id"     text,
        "layout"        jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "updated_at"    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_invoice_templates" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_invoice_templates_doc_branch" ON "invoice_templates" ("document_type","branch_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_invoice_templates_doc" ON "invoice_templates" ("document_type")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "invoice_templates"`);
  }
}
