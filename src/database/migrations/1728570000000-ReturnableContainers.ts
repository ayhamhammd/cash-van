import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Returnable containers — the empty bucket, crate or basket a product ships in.
 *
 * A dairy rep sells ten 6 kg tubs of halloumi; days later the customer hands
 * back three EMPTY buckets. The bucket has no sale value and was never a line on
 * the invoice — nobody sells an empty bucket — so this cannot be a sales return:
 * the return-by-item allocator matches a returned item against past SALE lines
 * of that same item, and there are none.
 *
 * So the empty container is an item in its own right, an ordinary item POINTS AT
 * the container it ships in, containers going out are DERIVED from sale lines
 * and never documented, and only the movement of empties is a document. The full
 * design is in docs/PLAN-returnable-containers.md.
 *
 * Mirrors the ERP's migration 0181 — same three item columns, same org flag,
 * same defaults — because the two sides compute the outstanding balance from the
 * same rule and must not disagree about the inputs.
 *
 * The balance itself is a VIEW, not a table. Everything it needs is already in
 * voucher_transactions, and a stored copy of those same rows could only ever
 * add a way for the two to disagree.
 *
 * Ships OFF. With no container items linked every balance is legitimately zero,
 * so nothing changes for any existing client until the flag is set and the links
 * are made.
 */
export class ReturnableContainers1728570000000 implements MigrationInterface {
  name = 'ReturnableContainers1728570000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── The catalogue half (mirrors the ERP via erp-sync) ────────────────────
    await q.query(
      `ALTER TABLE item_cart ADD COLUMN IF NOT EXISTS is_returnable_container boolean NOT NULL DEFAULT false`,
    );
    // The container's own item_number, not an id: erp-sync resolves the ERP's
    // container SKU through erp_id_map and stores what it resolved to, so a
    // voucher line can name the container the same way it names anything else.
    await q.query(
      `ALTER TABLE item_cart ADD COLUMN IF NOT EXISTS container_item_number text`,
    );
    // Containers per BASE PIECE. A 6 kg tub carries 1; a carton of four carries
    // 4. The derivation multiplies base pieces (item_qty × unit_base_qty), so a
    // line entered in cartons counts four and not one.
    await q.query(
      `ALTER TABLE item_cart ADD COLUMN IF NOT EXISTS containers_per_base_unit integer NOT NULL DEFAULT 1`,
    );
    await q.query(
      `ALTER TABLE item_cart ADD CONSTRAINT item_cart_containers_per_unit_chk
         CHECK (containers_per_base_unit > 0)`,
    );
    // One level only: a container cannot itself ship in a container, and nothing
    // is its own container. Without this a cycle is representable and the
    // balance walk can recurse.
    await q.query(
      `ALTER TABLE item_cart ADD CONSTRAINT item_cart_container_one_level_chk
         CHECK (
           container_item_number IS DISTINCT FROM item_number
           AND NOT (is_returnable_container AND container_item_number IS NOT NULL)
         )`,
    );
    // The outbound derivation's hot path: "every item that ships in a
    // container", which is almost no rows.
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_item_cart_container
         ON item_cart (container_item_number)
         WHERE container_item_number IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_item_cart_is_container
         ON item_cart (item_number)
         WHERE is_returnable_container`,
    );

    // ── The two gates ────────────────────────────────────────────────────────
    await q.query(
      `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS containers_enabled boolean NOT NULL DEFAULT false`,
    );
    // Opt-in, deliberately. SYSTEM-OVERVIEW §4.4: a capability that gives
    // something away must not be granted by a server that has not heard of it.
    await q.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS can_handle_containers boolean NOT NULL DEFAULT false`,
    );

    // ── The outstanding-balance view ─────────────────────────────────────────
    // DERIVED, with no table behind it. Every fact it needs is already in
    // voucher_transactions: what went out is implied by the sale lines, what
    // came back is a container document's own lines. A container_movements
    // table was drafted here and removed — it would have been a second copy of
    // those same rows, and the only thing a second copy can do that one cannot
    // is disagree.
    //
    // Two halves, unioned:
    //
    //   OUT  every posted SALE line whose item ships in a container, counted as
    //        BASE PIECES × containers_per_base_unit. A line entered in cartons
    //        of four therefore counts four buckets, not one.
    //   IN   every posted CONTAINER_IN line (negative), CONTAINER_OUT (positive)
    //        — packaging lent with no sale behind it.
    //
    // A positive total is what the customer still holds.
    await q.query(`
      CREATE OR REPLACE VIEW container_balances AS
      WITH moves AS (
        -- Implied by the sale: nothing is documented, nothing is printed.
        SELECT vh.customer_number,
               i.container_item_number                        AS container_item_number,
               vh.user_code,
               vh.in_date,
               -- NET OF GOODS RETURNED. A tub that came back as PRODUCT took
               -- its bucket with it, so it never stayed with the customer; an
               -- empty handed back on its own is a CONTAINER_IN instead, so the
               -- two cannot double-count. qty_returned is maintained by the
               -- return allocator (migration ReturnAllocation).
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

    // The view's two scans both filter on trans_kind then join by item, and
    // voucher_transactions is the busiest table in the schema.
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_voucher_headers_container_kinds
         ON voucher_headers (trans_kind, customer_number)
         WHERE trans_kind IN ('CONTAINER_IN', 'CONTAINER_OUT')`,
    );

    // ── The two voucher kinds ────────────────────────────────────────────────
    // Seeded here as well as in STANDARD_TRANS_KINDS so an existing database
    // can post them the moment the code lands, without waiting for a restart.
    await q.query(`
      INSERT INTO transaction_kinds (trans_kind, trans_name, sign)
      VALUES ('CONTAINER_IN', 'استلام فوارغ', 1),
             ('CONTAINER_OUT', 'تسليم فوارغ', -1)
      ON CONFLICT (trans_kind) DO NOTHING`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DELETE FROM transaction_kinds WHERE trans_kind IN ('CONTAINER_IN', 'CONTAINER_OUT')`,
    );
    await q.query(`DROP VIEW IF EXISTS container_balances`);
    await q.query(`DROP INDEX IF EXISTS idx_voucher_headers_container_kinds`);
    await q.query(`ALTER TABLE users DROP COLUMN IF EXISTS can_handle_containers`);
    await q.query(`ALTER TABLE app_settings DROP COLUMN IF EXISTS containers_enabled`);
    await q.query(`DROP INDEX IF EXISTS idx_item_cart_is_container`);
    await q.query(`DROP INDEX IF EXISTS idx_item_cart_container`);
    await q.query(
      `ALTER TABLE item_cart DROP CONSTRAINT IF EXISTS item_cart_container_one_level_chk`,
    );
    await q.query(
      `ALTER TABLE item_cart DROP CONSTRAINT IF EXISTS item_cart_containers_per_unit_chk`,
    );
    await q.query(`ALTER TABLE item_cart DROP COLUMN IF EXISTS containers_per_base_unit`);
    await q.query(`ALTER TABLE item_cart DROP COLUMN IF EXISTS container_item_number`);
    await q.query(`ALTER TABLE item_cart DROP COLUMN IF EXISTS is_returnable_container`);
  }
}
