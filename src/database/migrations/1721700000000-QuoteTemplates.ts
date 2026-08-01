import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Prospecting P1: reusable price-quote templates. A template holds the company
 * presentation (logo/description/phones), a product+price snapshot (jsonb — the
 * prices are the OUTREACH prices, deliberately decoupled from the live catalog),
 * and a WhatsApp message. `public_token` gives the quote page a stable
 * unguessable public URL (/q/<token>) that cold prospects open without auth.
 */
export class QuoteTemplates1721700000000 implements MigrationInterface {
  name = 'QuoteTemplates1721700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "quote_templates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" text NOT NULL,
        "logo_url" text,
        "description_ar" text,
        "phones" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "items" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "whatsapp_message_ar" text,
        "public_token" text NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "pk_quote_templates" PRIMARY KEY ("id"),
        CONSTRAINT "uq_quote_templates_token" UNIQUE ("public_token")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "quote_templates"`);
  }
}
