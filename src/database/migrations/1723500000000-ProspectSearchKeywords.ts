import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The rep's own search terms on a lead-finder run.
 *
 * The category allow-list only covers trades Google has a Places *type* for, so
 * a search can now also carry words the rep typed themselves, matched against
 * the business name. Recorded next to `categories` because the two together are
 * what a run *was* — without them, re-reading a search's history would
 * misreport why those leads came back.
 *
 * A jsonb array rather than one text column: a rep hunting a trade the list
 * doesn't cover rarely has a single word for it ("مكتبة", "قرطاسية").
 */
export class ProspectSearchKeywords1723500000000 implements MigrationInterface {
  name = 'ProspectSearchKeywords1723500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "prospect_searches"
         ADD COLUMN IF NOT EXISTS "keywords" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "prospect_searches" DROP COLUMN IF EXISTS "keywords"`,
    );
  }
}
