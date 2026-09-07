import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A customer belongs to exactly ONE segment.
 *
 * The table only ever enforced one row per (segment, customer), which stops the
 * same customer joining the SAME segment twice but leaves them free to join any
 * number of others — and they did: production carried two customers sitting in
 * two segments each, added by hand.
 *
 * The rule now lives in the schema rather than only in the service, so it holds
 * for every writer — the rules engine, an import, a future endpoint — not just
 * the one method that checks it. addMembers still refuses first, with a message
 * naming the segment already holding the customer, so people get an explanation
 * rather than a constraint violation.
 *
 * Existing overlaps are resolved by keeping the EARLIEST membership: the first
 * assignment is the deliberate one, later rows are the accidents this rule
 * exists to prevent.
 */
export class OneSegmentPerCustomer1726200000000 implements MigrationInterface {
  name = 'OneSegmentPerCustomer1726200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Keep exactly one row per customer — earliest added_at wins, ctid breaks a
    // tie so two rows stamped the same instant can't both survive and defeat the
    // index we are about to add.
    await queryRunner.query(`
      DELETE FROM segment_customers sc
      WHERE sc.ctid NOT IN (
        SELECT DISTINCT ON (customer_id) ctid
        FROM segment_customers
        ORDER BY customer_id, added_at ASC, ctid ASC
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_segment_customers_customer"
         ON "segment_customers" ("customer_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only the rule can be lifted. The memberships it deleted are gone.
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_segment_customers_customer"`);
  }
}
