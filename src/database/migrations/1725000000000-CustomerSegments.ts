import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer segmentation primitive: a named group (`customer_segments`) and its
 * membership (`segment_customers`). Membership is the single read path other
 * features (offers, analytics, rep assignment) will point at, so both hand-picked
 * and rule-driven members land in the same table. The unique (segment, customer)
 * index is the rule that a customer appears in a segment at most once.
 */
export class CustomerSegments1725000000000 implements MigrationInterface {
  name = 'CustomerSegments1725000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "customer_segments" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        "deleted_at"  timestamptz,
        "version"     integer NOT NULL DEFAULT 1,
        "name_ar"     text NOT NULL,
        "name_en"     text,
        "description" text,
        "color"       text,
        "kind"        text NOT NULL DEFAULT 'STATIC',
        "rules"       jsonb,
        "is_active"   boolean NOT NULL DEFAULT true,
        "is_system"   boolean NOT NULL DEFAULT false,
        "created_by"  uuid
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_customer_segments_kind" ON "customer_segments" ("kind")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_customer_segments_active" ON "customer_segments" ("is_active")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "segment_customers" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        "deleted_at"  timestamptz,
        "version"     integer NOT NULL DEFAULT 1,
        "segment_id"  uuid NOT NULL REFERENCES "customer_segments"("id") ON DELETE CASCADE,
        "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
        "source"      text NOT NULL DEFAULT 'MANUAL',
        "added_by"    uuid,
        "added_at"    timestamptz NOT NULL DEFAULT now()
      )
    `);
    // A customer appears in a segment at most once.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_segment_customers_pair"
         ON "segment_customers" ("segment_id", "customer_id")`,
    );
    // Both directions are hot: "who is in this segment" and "which segments is this customer in".
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_segment_customers_segment" ON "segment_customers" ("segment_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_segment_customers_customer" ON "segment_customers" ("customer_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "segment_customers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_segments"`);
  }
}
