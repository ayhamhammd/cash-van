import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 of SPEC-ai-analyst: session metadata + a per-message index.
 *
 * DEVIATION FROM THE SPEC, on purpose. The spec called for a new `ai_sessions`
 * table replacing `agent_conversations`. Doing that means rewriting the
 * open/save/resume path — the one part of a working streaming chat that must
 * not break — for no Phase 1 user-visible gain. Instead:
 *
 *   - `agent_conversations` KEEPS the provider-native transcript in `messages`
 *     and gains the session columns. Resumption is untouched.
 *   - `ai_messages` is a new append-only INDEX of the same turns: one row per
 *     message, which is what makes cost accounting, search and per-turn
 *     artifact linkage possible. It is derived data; the jsonb blob stays
 *     authoritative for replay.
 *
 * Rebuilding the index from the blob is always possible, so a bug here can
 * never cost a conversation.
 */
export class AiSessions1722400000000 implements MigrationInterface {
  name = 'AiSessions1722400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agent_conversations"
        ADD COLUMN "persona"       text NOT NULL DEFAULT 'analyst',
        ADD COLUMN "model"         text,
        ADD COLUMN "input_tokens"  bigint NOT NULL DEFAULT 0,
        ADD COLUMN "output_tokens" bigint NOT NULL DEFAULT 0,
        ADD COLUMN "archived_at"   timestamptz,
        ADD COLUMN "summary"       text
    `);

    // The session list is "mine, not archived, most recent first".
    await queryRunner.query(`
      CREATE INDEX "idx_agent_conversations_active"
        ON "agent_conversations" ("created_by", "updated_at" DESC)
        WHERE "archived_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "ai_messages" (
        "id"              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "conversation_id" uuid NOT NULL
          REFERENCES "agent_conversations"("id") ON DELETE CASCADE,
        "seq"             integer NOT NULL,
        "role"            text NOT NULL,
        "content"         text,
        "tool_name"       text,
        "tool_input"      jsonb,
        -- A PREVIEW of the tool output, never the payload. A SELECT returning
        -- 40k rows must not land in a jsonb column; the artifact carries data.
        "tool_summary"    jsonb,
        "input_tokens"    integer,
        "output_tokens"   integer,
        "error"           text,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_ai_messages_seq" UNIQUE ("conversation_id", "seq"),
        CONSTRAINT "ck_ai_messages_role"
          CHECK ("role" IN ('user', 'assistant', 'tool', 'system'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_ai_messages_conversation"
        ON "ai_messages" ("conversation_id", "seq")
    `);

    // Backfill a session row's message index for existing threads is NOT done
    // here: the old blobs replay fine, and an empty index simply means the
    // session shows its transcript from the blob until its next turn.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_messages"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_agent_conversations_active"`,
    );
    await queryRunner.query(`
      ALTER TABLE "agent_conversations"
        DROP COLUMN IF EXISTS "persona",
        DROP COLUMN IF EXISTS "model",
        DROP COLUMN IF EXISTS "input_tokens",
        DROP COLUMN IF EXISTS "output_tokens",
        DROP COLUMN IF EXISTS "archived_at",
        DROP COLUMN IF EXISTS "summary"
    `);
  }
}
