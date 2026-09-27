import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One stock model — the ERP's (docs/SPEC-single-stock-model.md).
 *
 * Until now cash-van stored no stock figure: `item_balance` was a VIEW that
 * re-summed every posted voucher line ever written, on every read. This gives
 * cash-van what the ERP has — an append-only movement ledger and a stored
 * balance, changed together by ONE function — and enforces it in the database,
 * so no writer (TypeORM save, raw mirror insert, a future script) can change a
 * posted line without the balance following.
 *
 * The definition is unchanged: a posted line takes `item_qty` out of its
 * from_store and puts it into its to_store. What changes is that it is applied
 * once, when it happens, instead of replayed on every read.
 *
 *  1. stock_movements / stock_balance — quantities as bigint ×1000, like the ERP.
 *  2. stock_apply()     — the only writer of either table.
 *  3. stock_sync_line() — what a line should have applied minus what it has,
 *                         applied through stock_apply(). Idempotent.
 *  4. Triggers on voucher_transactions and voucher_headers.
 *  5. Backfill from every existing posted line.
 *  6. The old replay view is kept as item_balance_replay (for verification) and
 *     item_balance is redefined over stock_balance with the same columns, so all
 *     of its readers switch without a code change.
 */
export class StockLedger1727800000000 implements MigrationInterface {
  name = 'StockLedger1727800000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── 1. Tables ──────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "stock_movements" (
        "seq"             bigserial PRIMARY KEY,
        "store_number"    text        NOT NULL,
        "item_number"     text        NOT NULL,
        "stock_unit_code" text        NOT NULL DEFAULT '',
        "qty_milli"       bigint      NOT NULL,
        "txn_id"          uuid,
        "voucher_number"  text,
        "reason"          text        NOT NULL,
        "created_at"      timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX "idx_stock_movements_txn" ON "stock_movements" ("txn_id")`);
    await q.query(
      `CREATE INDEX "idx_stock_movements_pool" ON "stock_movements" ("store_number", "item_number", "stock_unit_code", "seq")`,
    );
    await q.query(`
      CREATE TABLE "stock_balance" (
        "store_number"    text        NOT NULL,
        "item_number"     text        NOT NULL,
        "stock_unit_code" text        NOT NULL DEFAULT '',
        "qty_milli"       bigint      NOT NULL DEFAULT 0,
        "last_seq"        bigint      NOT NULL DEFAULT 0,
        "updated_at"      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("store_number", "item_number", "stock_unit_code")
      )`);
    await q.query(`CREATE INDEX "idx_stock_balance_item" ON "stock_balance" ("item_number")`);

    // ── 2. The one writer ──────────────────────────────────────────────────
    await q.query(`
      CREATE FUNCTION stock_apply(
        p_store text, p_item text, p_pool text, p_milli bigint,
        p_txn uuid, p_voucher text, p_reason text
      ) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE v_seq bigint;
      BEGIN
        IF p_store IS NULL OR p_milli IS NULL OR p_milli = 0 THEN RETURN; END IF;
        INSERT INTO stock_movements
          (store_number, item_number, stock_unit_code, qty_milli, txn_id, voucher_number, reason)
        VALUES (p_store, p_item, COALESCE(p_pool, ''), p_milli, p_txn, p_voucher, p_reason)
        RETURNING seq INTO v_seq;
        INSERT INTO stock_balance (store_number, item_number, stock_unit_code, qty_milli, last_seq, updated_at)
        VALUES (p_store, p_item, COALESCE(p_pool, ''), p_milli, v_seq, now())
        ON CONFLICT (store_number, item_number, stock_unit_code) DO UPDATE
          SET qty_milli  = stock_balance.qty_milli + EXCLUDED.qty_milli,
              last_seq   = GREATEST(stock_balance.last_seq, EXCLUDED.last_seq),
              updated_at = now();
      END $$`);

    // ── 3. What a line should have applied, minus what it has ──────────────
    await q.query(`
      CREATE FUNCTION stock_sync_line(
        p_txn uuid, p_voucher text, p_item text, p_pool text,
        p_from text, p_to text, p_qty numeric, p_posted boolean, p_reason text
      ) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE r record;
      BEGIN
        FOR r IN
          WITH desired AS (
            SELECT p_from AS store_number, p_item AS item_number, COALESCE(p_pool, '') AS stock_unit_code,
                   -round(p_qty * 1000)::bigint AS qty
             WHERE p_posted AND p_from IS NOT NULL
            UNION ALL
            SELECT p_to, p_item, COALESCE(p_pool, ''), round(p_qty * 1000)::bigint
             WHERE p_posted AND p_to IS NOT NULL
          ), applied AS (
            SELECT store_number, item_number, stock_unit_code, -SUM(qty_milli)::bigint AS qty
              FROM stock_movements
             WHERE txn_id = p_txn
             GROUP BY store_number, item_number, stock_unit_code
          )
          SELECT store_number, item_number, stock_unit_code, SUM(qty)::bigint AS qty
            FROM (SELECT * FROM desired UNION ALL SELECT * FROM applied) d
           GROUP BY store_number, item_number, stock_unit_code
          HAVING SUM(qty) <> 0
           ORDER BY store_number, item_number, stock_unit_code
        LOOP
          PERFORM stock_apply(r.store_number, r.item_number, r.stock_unit_code, r.qty,
                              p_txn, p_voucher, p_reason);
        END LOOP;
      END $$`);

    // ── 4. Triggers ────────────────────────────────────────────────────────
    await q.query(`
      CREATE FUNCTION stock_line_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_posted boolean;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          PERFORM stock_sync_line(OLD.id, OLD.voucher_number, OLD.item_number, OLD.stock_unit_code,
                                  OLD.from_store_number, OLD.to_store_number, OLD.item_qty, FALSE, 'delete');
          RETURN OLD;
        END IF;
        SELECT vh.is_posted INTO v_posted FROM voucher_headers vh WHERE vh.voucher_number = NEW.voucher_number;
        -- No special case for a line moved to another item, pool or store: what the
        -- line has applied is summed per (store, item, pool), so whatever it no
        -- longer should hold is taken back out by the same difference.
        PERFORM stock_sync_line(NEW.id, NEW.voucher_number, NEW.item_number, NEW.stock_unit_code,
                                NEW.from_store_number, NEW.to_store_number, NEW.item_qty,
                                COALESCE(v_posted, FALSE),
                                CASE WHEN TG_OP = 'INSERT' THEN 'post' ELSE 'edit' END);
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER stock_line_ins AFTER INSERT ON voucher_transactions
        FOR EACH ROW EXECUTE FUNCTION stock_line_trigger()`);
    await q.query(`
      CREATE TRIGGER stock_line_upd
        AFTER UPDATE OF item_qty, from_store_number, to_store_number, stock_unit_code, item_number, voucher_number
        ON voucher_transactions
        FOR EACH ROW EXECUTE FUNCTION stock_line_trigger()`);
    await q.query(`
      CREATE TRIGGER stock_line_del AFTER DELETE ON voucher_transactions
        FOR EACH ROW EXECUTE FUNCTION stock_line_trigger()`);

    await q.query(`
      CREATE FUNCTION stock_header_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE l record;
      BEGIN
        IF OLD.is_posted IS NOT DISTINCT FROM NEW.is_posted THEN RETURN NEW; END IF;
        FOR l IN SELECT * FROM voucher_transactions WHERE voucher_number = NEW.voucher_number ORDER BY id LOOP
          PERFORM stock_sync_line(l.id, l.voucher_number, l.item_number, l.stock_unit_code,
                                  l.from_store_number, l.to_store_number, l.item_qty,
                                  NEW.is_posted, CASE WHEN NEW.is_posted THEN 'post' ELSE 'unpost' END);
        END LOOP;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER stock_header_posted AFTER UPDATE OF is_posted ON voucher_headers
        FOR EACH ROW EXECUTE FUNCTION stock_header_trigger()`);

    // ── 5. Backfill: one movement per existing posted line side ────────────
    await q.query(`
      INSERT INTO stock_movements
        (store_number, item_number, stock_unit_code, qty_milli, txn_id, voucher_number, reason, created_at)
      SELECT s.store_number, vt.item_number, COALESCE(vt.stock_unit_code, ''), s.qty,
             vt.id, vt.voucher_number, 'backfill', vh.in_date
        FROM voucher_transactions vt
        JOIN voucher_headers vh ON vh.voucher_number = vt.voucher_number AND vh.is_posted = TRUE
        CROSS JOIN LATERAL (
          VALUES (vt.from_store_number, -round(vt.item_qty * 1000)::bigint),
                 (vt.to_store_number,    round(vt.item_qty * 1000)::bigint)
        ) AS s(store_number, qty)
       WHERE s.store_number IS NOT NULL AND s.qty <> 0
       ORDER BY vh.in_date, vt.voucher_number, vt.id`);
    await q.query(`
      INSERT INTO stock_balance (store_number, item_number, stock_unit_code, qty_milli, last_seq, updated_at)
      SELECT store_number, item_number, stock_unit_code, SUM(qty_milli), MAX(seq), now()
        FROM stock_movements
       GROUP BY store_number, item_number, stock_unit_code`);

    // ── 6. Views: keep the replay for verification, serve the stored balance ─
    await q.query(`DROP VIEW IF EXISTS "item_balance_total"`);
    await q.query(`ALTER VIEW "item_balance" RENAME TO "item_balance_replay"`);
    await q.query(`
      CREATE VIEW "item_balance" AS
      SELECT
        ic.item_number                                           AS item_number,
        ic.item_name                                             AS item_name,
        b.store_number                                           AS stock_number,
        COALESCE(b.stock_unit_code, '')                          AS stock_unit_code,
        (COALESCE(SUM(b.qty_milli), 0)::numeric / 1000)::numeric(14,3) AS qty
      FROM item_cart ic
      LEFT JOIN stock_balance b ON b.item_number = ic.item_number
      GROUP BY ic.item_number, ic.item_name, b.store_number, COALESCE(b.stock_unit_code, '')`);
    await q.query(`
      CREATE VIEW "item_balance_total" AS
      SELECT item_number, item_name, stock_number, SUM(qty)::numeric(14,3) AS qty
        FROM item_balance
       GROUP BY item_number, item_name, stock_number`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP VIEW IF EXISTS "item_balance_total"`);
    await q.query(`DROP VIEW IF EXISTS "item_balance"`);
    await q.query(`ALTER VIEW "item_balance_replay" RENAME TO "item_balance"`);
    await q.query(`
      CREATE VIEW "item_balance_total" AS
      SELECT item_number, item_name, stock_number, SUM(qty)::numeric(14,3) AS qty
        FROM item_balance
       GROUP BY item_number, item_name, stock_number`);
    await q.query(`DROP TRIGGER IF EXISTS stock_header_posted ON voucher_headers`);
    await q.query(`DROP TRIGGER IF EXISTS stock_line_del ON voucher_transactions`);
    await q.query(`DROP TRIGGER IF EXISTS stock_line_upd ON voucher_transactions`);
    await q.query(`DROP TRIGGER IF EXISTS stock_line_ins ON voucher_transactions`);
    await q.query(`DROP FUNCTION IF EXISTS stock_header_trigger()`);
    await q.query(`DROP FUNCTION IF EXISTS stock_line_trigger()`);
    await q.query(
      `DROP FUNCTION IF EXISTS stock_sync_line(uuid, text, text, text, text, text, numeric, boolean, text)`,
    );
    await q.query(
      `DROP FUNCTION IF EXISTS stock_apply(text, text, text, bigint, uuid, text, text)`,
    );
    await q.query(`DROP TABLE IF EXISTS "stock_balance"`);
    await q.query(`DROP TABLE IF EXISTS "stock_movements"`);
  }
}
