import { MigrationInterface, QueryRunner } from 'typeorm';

/** Outbound queue for pushing van transactions (sales/returns/payments) to the ERP. */
export class ErpOutbox1719100000000 implements MigrationInterface {
  name = 'ErpOutbox1719100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "erp_outbox" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "kind" text NOT NULL,
        "ref" text NOT NULL,
        "status" text NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
        "error" text,
        "result_ref" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_erp_outbox" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_erp_outbox_status" ON "erp_outbox" ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_erp_outbox_ref" ON "erp_outbox" ("ref")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "erp_outbox"`);
  }
}
