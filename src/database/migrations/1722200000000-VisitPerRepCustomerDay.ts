import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One visit per (rep, customer, calendar day).
 *
 * A rep now records a visit when they OPEN a customer, and a voucher records one
 * too. Without a key those are two rows for one doorstep, and the dashboard
 * would count the same call twice — once as a no-sale visit, once as a sale.
 *
 * Existing rows are collapsed first, or the unique index cannot be created:
 * the survivor is the earliest visit of that day, it inherits `had_sale` if ANY
 * of the merged rows had a sale, and it keeps the first coordinates and note
 * that were actually recorded.
 *
 * The day is computed in UTC, matching how `visited_at` is stored and how the
 * tracking queries already bucket by date.
 */
export class VisitPerRepCustomerDay1722200000000 implements MigrationInterface {
  name = 'VisitPerRepCustomerDay1722200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Fold each day's duplicates into the earliest row.
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               rep_id, customer_id, (visited_at AT TIME ZONE 'UTC')::date AS day,
               ROW_NUMBER() OVER (
                 PARTITION BY rep_id, customer_id, (visited_at AT TIME ZONE 'UTC')::date
                 ORDER BY visited_at ASC, id ASC
               ) AS rn
        FROM customer_visits
      ),
      keepers AS (SELECT id, rep_id, customer_id, day FROM ranked WHERE rn = 1),
      merged AS (
        SELECT k.id,
               bool_or(v.had_sale)                                   AS had_sale,
               (array_agg(v.lat  ORDER BY v.visited_at)
                  FILTER (WHERE v.lat IS NOT NULL))[1]               AS lat,
               (array_agg(v.lng  ORDER BY v.visited_at)
                  FILTER (WHERE v.lng IS NOT NULL))[1]               AS lng,
               (array_agg(v.visit_note ORDER BY v.visited_at)
                  FILTER (WHERE v.visit_note IS NOT NULL))[1]        AS visit_note
        FROM keepers k
        JOIN customer_visits v
          ON v.rep_id = k.rep_id
         AND v.customer_id = k.customer_id
         AND (v.visited_at AT TIME ZONE 'UTC')::date = k.day
        GROUP BY k.id
      )
      UPDATE customer_visits cv
         SET had_sale   = m.had_sale,
             lat        = COALESCE(cv.lat, m.lat),
             lng        = COALESCE(cv.lng, m.lng),
             visit_note = COALESCE(cv.visit_note, m.visit_note)
        FROM merged m
       WHERE cv.id = m.id
    `);

    // 2. Drop the now-redundant rows.
    await queryRunner.query(`
      DELETE FROM customer_visits cv
       USING (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY rep_id, customer_id, (visited_at AT TIME ZONE 'UTC')::date
                  ORDER BY visited_at ASC, id ASC
                ) AS rn
           FROM customer_visits
       ) d
       WHERE cv.id = d.id AND d.rn > 1
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_customer_visit_rep_customer_day"
        ON "customer_visits" ("rep_id", "customer_id", (("visited_at" AT TIME ZONE 'UTC')::date))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The collapse is not reversible — merged rows are gone. Only the constraint
    // is dropped, which is what a rollback actually needs.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_customer_visit_rep_customer_day"`,
    );
  }
}
