import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI report agent — stores chat conversations (so multi-turn context survives
 * across requests) and metadata for every report file the agent generates (so
 * the files can be downloaded again later). Report bytes live in object
 * storage; only the pointer + metadata are kept here.
 */
export class AddAiReportAgent1718700000000 implements MigrationInterface {
  name = 'AddAiReportAgent1718700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_conversations" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "title"      text,
        "created_by" uuid,
        "messages"   jsonb NOT NULL DEFAULT '[]'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_agent_conversations_updated"
         ON "agent_conversations" ("updated_at" DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_reports" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "conversation_id" uuid REFERENCES "agent_conversations" ("id") ON DELETE SET NULL,
        "title"           text,
        "format"          text NOT NULL,
        "filename"        text NOT NULL,
        "storage_key"     text NOT NULL,
        "content_type"    text NOT NULL,
        "row_count"       integer NOT NULL DEFAULT 0,
        "sql_text"        text,
        "created_by"      uuid,
        "created_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_agent_reports_conversation"
         ON "agent_reports" ("conversation_id", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_reports"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_conversations"`);
  }
}
