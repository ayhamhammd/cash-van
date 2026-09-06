import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A customer must be able to belong to MANY segments.
 *
 * The intended rule has always been "one row per (segment, customer)" —
 * `uq_segment_customers_pair` — which stops the same customer being added to the
 * SAME segment twice while leaving them free to join any number of others. Some
 * databases, however, carry a stricter leftover: a UNIQUE key on `customer_id`
 * ALONE, which silently pins each customer to exactly one segment.
 *
 * It fails invisibly. addMembers() inserts with `.orIgnore()` (there to absorb the
 * race on the pair index), so a violation of that stricter key is swallowed: the
 * click reports success, nothing is written, and the customer never shows up in
 * the second segment — with no error anywhere to explain it.
 *
 * Drop any such key, whatever it was named, and reassert the correct pair rule.
 */
export class SegmentMultiMembership1725700000000 implements MigrationInterface {
  name = 'SegmentMultiMembership1725700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        IF to_regclass('public.segment_customers') IS NULL THEN
          RETURN;
        END IF;

        -- Any UNIQUE index whose key list is exactly (customer_id). The regex
        -- deliberately does NOT match "(segment_id, customer_id)".
        FOR r IN
          SELECT i.indexname AS idx, c.conname AS con
          FROM pg_indexes i
          LEFT JOIN pg_constraint c
            ON c.conname  = i.indexname
           AND c.conrelid = 'public.segment_customers'::regclass
           AND c.contype  = 'u'
          WHERE i.schemaname = 'public'
            AND i.tablename  = 'segment_customers'
            AND i.indexdef ILIKE '%UNIQUE%'
            AND i.indexdef ~ '\\(customer_id\\)'
        LOOP
          IF r.con IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.segment_customers DROP CONSTRAINT %I', r.con);
          ELSE
            EXECUTE format('DROP INDEX IF EXISTS public.%I', r.idx);
          END IF;
        END LOOP;
      END $$;
    `);

    // Reassert the rule we DO want: a customer appears in a segment at most once.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_segment_customers_pair"
         ON "segment_customers" ("segment_id", "customer_id")`,
    );
  }

  public async down(): Promise<void> {
    // Deliberately irreversible. Re-adding a one-segment-per-customer key would
    // have to delete real memberships to satisfy itself.
  }
}
