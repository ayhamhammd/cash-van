import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI assistant configuration on app_settings — lets an admin choose the LLM
 * provider (Anthropic / OpenAI / Gemini) and store its API key (encrypted) from
 * the Settings UI, instead of only via env. The agent resolves the provider +
 * key from here at request time, falling back to env when AI is disabled here.
 */
export class AiConfig1720500000000 implements MigrationInterface {
  name = 'AiConfig1720500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_settings"
        ADD COLUMN IF NOT EXISTS "ai_enabled"              boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "ai_provider"             text NOT NULL DEFAULT 'anthropic',
        ADD COLUMN IF NOT EXISTS "ai_model"                text,
        ADD COLUMN IF NOT EXISTS "ai_api_key_encrypted"    text,
        ADD COLUMN IF NOT EXISTS "ai_api_key_last4"        text,
        ADD COLUMN IF NOT EXISTS "ai_confidence_threshold" integer NOT NULL DEFAULT 75,
        ADD COLUMN IF NOT EXISTS "ai_language"             text NOT NULL DEFAULT 'auto',
        ADD COLUMN IF NOT EXISTS "ai_capabilities"         jsonb NOT NULL DEFAULT '{}'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_settings"
        DROP COLUMN IF EXISTS "ai_enabled",
        DROP COLUMN IF EXISTS "ai_provider",
        DROP COLUMN IF EXISTS "ai_model",
        DROP COLUMN IF EXISTS "ai_api_key_encrypted",
        DROP COLUMN IF EXISTS "ai_api_key_last4",
        DROP COLUMN IF EXISTS "ai_confidence_threshold",
        DROP COLUMN IF EXISTS "ai_language",
        DROP COLUMN IF EXISTS "ai_capabilities"
    `);
  }
}
