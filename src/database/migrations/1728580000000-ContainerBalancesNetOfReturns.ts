import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Re-create `container_balances` so an ALREADY-MIGRATED database nets goods
 * returned off the containers a customer is holding.
 *
 * The rule itself arrived as an edit to the ReturnableContainers migration: a
 * tub that came back as PRODUCT took its bucket with it, so it never stayed
 * with the customer, and an empty handed back on its own is a CONTAINER_IN —
 * the two must not double-count.
 *
 * But editing a migration that has already run changes nothing. TypeORM records
 * it by name in `migrations` and never looks at it again, so every database
 * that applied ReturnableContainers before that edit keeps the OLD view and
 * silently overstates what every customer owes. The code reads one rule and the
 * database computes another, with nothing anywhere reporting a problem — found
 * exactly that way, by a test that asserted 7 and got 10.
 *
 * So the definition is applied again here, as its own migration. A fresh
 * database gets it from the edited original and this is a harmless no-op;
 * a database that ran the original earlier gets it here. `CREATE OR REPLACE
 * VIEW` makes that idempotent either way, and the two definitions must be kept
 * identical — if the view changes again, it changes in a new migration, not in
 * an old one.
 */
export class ContainerBalancesNetOfReturns1728580000000 implements MigrationInterface {
  name = 'ContainerBalancesNetOfReturns1728580000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE OR REPLACE VIEW container_balances AS
      WITH moves AS (
        -- Implied by the sale: nothing is documented, nothing is printed.
        SELECT vh.customer_number,
               i.container_item_number                        AS container_item_number,
               vh.user_code,
               vh.in_date,
               -- NET OF GOODS RETURNED, and netted BEFORE the multiplication:
               -- a line is in the unit it was sold in, so two cartons back out
               -- of five is (5 - 2) x 4 pieces, not 5 x 4 - 2.
               ((vt.item_qty - COALESCE(vt.qty_returned, 0))
                            * COALESCE(vt.unit_base_qty, 1)
                            * i.containers_per_base_unit)     AS qty
          FROM voucher_transactions vt
          JOIN voucher_headers vh ON vh.voucher_number = vt.voucher_number
          JOIN item_cart i        ON i.item_number     = vt.item_number
         WHERE vh.trans_kind = 'SALE'
           AND vh.is_posted
           AND i.container_item_number IS NOT NULL
           AND vh.customer_number IS NOT NULL

        UNION ALL

        -- The explicit documents. CONTAINER_IN reduces what the customer holds.
        SELECT vh.customer_number,
               vt.item_number                                 AS container_item_number,
               vh.user_code,
               vh.in_date,
               CASE WHEN vh.trans_kind = 'CONTAINER_IN'
                    THEN -(vt.item_qty * COALESCE(vt.unit_base_qty, 1))
                    ELSE  (vt.item_qty * COALESCE(vt.unit_base_qty, 1))
               END                                            AS qty
          FROM voucher_transactions vt
          JOIN voucher_headers vh ON vh.voucher_number = vt.voucher_number
         WHERE vh.trans_kind IN ('CONTAINER_IN', 'CONTAINER_OUT')
           AND vh.is_posted
           AND vh.customer_number IS NOT NULL
      )
      SELECT customer_number,
             container_item_number,
             SUM(qty)::numeric(14,3) AS outstanding,
             -- Aging from the OLDEST movement that put containers out, which is
             -- what the office chases. Taken from the document date and not from
             -- a stored snapshot, so amending history moves it honestly.
             MIN(in_date) FILTER (WHERE qty > 0) AS oldest_out_at,
             MAX(in_date)                        AS last_movement_at,
             -- The rep who last touched this customer's packaging: who to ask.
             (ARRAY_AGG(user_code ORDER BY in_date DESC))[1] AS last_user_code
        FROM moves
       GROUP BY customer_number, container_item_number
      HAVING SUM(qty) <> 0`);
  }

  /**
   * Back to counting every piece sold as a container still out. Only here so the
   * migration is reversible — the figure it restores is the wrong one.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE OR REPLACE VIEW container_balances AS
      WITH moves AS (
        SELECT vh.customer_number,
               i.container_item_number                        AS container_item_number,
               vh.user_code,
               vh.in_date,
               (vt.item_qty * COALESCE(vt.unit_base_qty, 1)
                            * i.containers_per_base_unit)     AS qty
          FROM voucher_transactions vt
          JOIN voucher_headers vh ON vh.voucher_number = vt.voucher_number
          JOIN item_cart i        ON i.item_number     = vt.item_number
         WHERE vh.trans_kind = 'SALE'
           AND vh.is_posted
           AND i.container_item_number IS NOT NULL
           AND vh.customer_number IS NOT NULL

        UNION ALL

        SELECT vh.customer_number,
               vt.item_number                                 AS container_item_number,
               vh.user_code,
               vh.in_date,
               CASE WHEN vh.trans_kind = 'CONTAINER_IN'
                    THEN -(vt.item_qty * COALESCE(vt.unit_base_qty, 1))
                    ELSE  (vt.item_qty * COALESCE(vt.unit_base_qty, 1))
               END                                            AS qty
          FROM voucher_transactions vt
          JOIN voucher_headers vh ON vh.voucher_number = vt.voucher_number
         WHERE vh.trans_kind IN ('CONTAINER_IN', 'CONTAINER_OUT')
           AND vh.is_posted
           AND vh.customer_number IS NOT NULL
      )
      SELECT customer_number,
             container_item_number,
             SUM(qty)::numeric(14,3) AS outstanding,
             MIN(in_date) FILTER (WHERE qty > 0) AS oldest_out_at,
             MAX(in_date)                        AS last_movement_at,
             (ARRAY_AGG(user_code ORDER BY in_date DESC))[1] AS last_user_code
        FROM moves
       GROUP BY customer_number, container_item_number
      HAVING SUM(qty) <> 0`);
  }
}
