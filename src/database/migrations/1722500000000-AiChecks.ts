import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SPEC-ai-analyst Phase 3: the auditor's check battery.
 *
 * Editable rows rather than constants in code, for two reasons. An admin can
 * disable a check that is noisy on their installation without waiting for a
 * deploy; and a check that starts erroring after a schema change can be
 * switched off without taking the whole auditor down with it.
 *
 * The model does NOT write these queries and cannot add to them. A model asked
 * to "find problems" invents them; given a fixed battery it can only explain
 * and rank what the SQL returned.
 *
 * HOW THESE SEVEN WERE ARRIVED AT, because the history matters for anyone
 * adding an eighth. Eight were drafted from the schema and executed. An
 * adversarial review then rejected ALL of them, with one shared root cause:
 * they were written by reading the SCHEMA and not the WRITE PATH. A column
 * exists and looks authoritative, but the application populates it in a way
 * that inverts the query's meaning —
 *
 *   • payment rows are OPTIONAL, so their absence means "on account", not
 *     "unrecorded" (vouchers.service.ts writes them only `if (dto.payments?.length)`)
 *   • discount_value is where the OFFERS ENGINE puts company-authorised
 *     promotions, not only rep discretion
 *   • erp_outbox 'pending' is the NORMAL state for the ~30s until the drainer runs
 *   • the geofence the app enforces is CUSTOMER_PROXIMITY_RADIUS_M, default 1000m
 *
 * Two drafts were structurally DEAD — incapable of ever firing:
 *   • "rep with sales but no visits": recordSaleVisit() runs on every voucher
 *     create, so a rep with sales always has visits. Dropped; no fix exists.
 *   • "van stock below zero": the write path clamps with Math.max(0, qty - n),
 *     so it can never go negative. Replaced by reserved > quantity, which IS
 *     reachable because `reserved` is only ever incremented.
 *
 * Every surviving check was then FIRE-TESTED: a fault injected inside
 * BEGIN/ROLLBACK, the check confirmed to return it, and the database confirmed
 * unchanged afterwards. Zero rows on a small database proves nothing, which is
 * how two dead checks nearly shipped.
 *
 * ADDING A CHECK: validate it against the service that writes the column, then
 * prove it fires on injected data. Both steps, or it is decoration.
 */
export class AiChecks1722500000000 implements MigrationInterface {
  name = 'AiChecks1722500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_checks" (
        "id"        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "key"       text NOT NULL UNIQUE,
        "title_ar"  text NOT NULL,
        "title_en"  text NOT NULL,
        "severity"  text NOT NULL,
        "sql"       text NOT NULL,
        "enabled"   boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_ai_checks_severity"
          CHECK ("severity" IN ('info', 'warn', 'critical'))
      )
    `);

    // ON CONFLICT so re-running against a database that already has the rows is
    // harmless, and so a site that edited a check keeps its edit.
    await queryRunner.query(`
      INSERT INTO "ai_checks" ("key", "title_ar", "title_en", "severity", "sql")
      VALUES
        ('customer_over_limit', 'عملاء تجاوزوا سقف الائتمان', 'Customers over their credit limit', 'critical',
         $chk$SELECT c.customer_number, c.customer_name, c.name_ar AS customer_name_ar, c.customer_type,
       c.credit_limit::numeric AS credit_limit,
       c.total_debt::numeric   AS outstanding_debt,
       (c.total_debt::numeric - c.credit_limit::numeric) AS over_limit_by,
       ROUND(c.total_debt::numeric * 100 / NULLIF(c.credit_limit::numeric, 0), 1) AS pct_of_limit,
       c.credit_hold, c.payment_terms, c.is_active AS customer_active,
       cfg.erp_sync_enabled AS debt_sourced_from_erp,
       cfg.erp_last_sync_at AS debt_as_of,
       COALESCE(unapplied.amt, 0) AS collections_since_debt_snapshot,
       COALESCE(allcoll.amt, 0)   AS collections_recorded_total,
       (c.total_debt::numeric - COALESCE(unapplied.amt, 0)) AS debt_net_of_unapplied_collections,
       r.name_ar AS rep_name, u.user_number AS rep_user_number,
       last_sale.voucher_number AS last_sale_voucher, last_sale.in_date AS last_sale_date
  FROM customers c
  CROSS JOIN (SELECT erp_sync_enabled, erp_last_sync_at FROM app_settings ORDER BY id LIMIT 1) cfg
  LEFT JOIN reps  r ON r.id = c.rep_id  AND r.deleted_at IS NULL
  LEFT JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
  LEFT JOIN LATERAL (
      SELECT SUM(co.amount)::numeric / 1000 AS amt FROM collections co
       WHERE co.customer_id = c.id AND co.status IN ('confirmed','deposited')
         AND (cfg.erp_last_sync_at IS NULL OR co.confirmed_at > cfg.erp_last_sync_at)
  ) unapplied ON TRUE
  LEFT JOIN LATERAL (
      SELECT SUM(co.amount)::numeric / 1000 AS amt FROM collections co
       WHERE co.customer_id = c.id AND co.status IN ('confirmed','deposited')
  ) allcoll ON TRUE
  LEFT JOIN LATERAL (
      SELECT h.voucher_number, h.in_date FROM voucher_headers h
       WHERE h.customer_number = c.customer_number AND h.trans_kind = 'SALE'
         AND h.is_posted AND h.deleted_at IS NULL
       ORDER BY h.in_date DESC LIMIT 1
  ) last_sale ON TRUE
 WHERE c.deleted_at IS NULL
   AND c.credit_limit::numeric > 0
   AND c.total_debt::numeric > c.credit_limit::numeric
 ORDER BY (c.total_debt::numeric - c.credit_limit::numeric) DESC
 LIMIT 200$chk$),
        ('van_stock_inconsistent', 'مخزون مركبة محجوز أكثر من المتوفر', 'Van stock reserved beyond what is loaded', 'critical',
         $chk$SELECT
    r.code                                        AS rep_code,
    COALESCE(r.name_ar, r.name_en)                AS rep_name,
    i.item_number                                 AS item_number,
    COALESCE(i.name_ar, i.item_name)              AS item_name,
    vs.quantity                                   AS on_van,
    vs.reserved                                   AS reserved,
    (vs.reserved - vs.quantity)                   AS short_by,
    CASE
      WHEN vs.quantity < 0 THEN 'negative_stock'
      ELSE 'reserved_exceeds_stock'
    END                                           AS problem,
    vs.snapshot_at                                AS last_movement
FROM van_stock vs
JOIN reps r      ON r.id = vs.rep_id      AND r.deleted_at IS NULL
JOIN item_cart i ON i.id = vs.product_id  AND i.deleted_at IS NULL
WHERE vs.quantity < 0
   OR vs.reserved > vs.quantity
ORDER BY (vs.reserved - vs.quantity) DESC, r.code
LIMIT 200$chk$),
        ('voucher_no_payment', 'فواتير بيع مرحّلة بدون أي سطر دفع', 'Posted SALE vouchers with no payment record', 'warn',
         $chk$SELECT h.voucher_number, h.in_date, h.user_code,
       COALESCE(r.name_en, r.name_ar, u.name) AS rep_name,
       h.customer_number,
       COALESCE(c.name_en, c.name_ar, c.customer_name) AS customer_name,
       h.net_total::numeric AS net_total,
       pay.settled::numeric AS recorded_payments,
       (h.net_total::numeric - pay.settled::numeric) AS shortfall,
       pay.rows_present AS payment_row_count,
       pay.types AS payment_types,
       (pay.rows_present = 0) AS no_payment_row_at_all,
       (pay.credit_amt > 0) AS booked_on_account,
       (SELECT count(*) FROM payments p2
         WHERE p2.voucher_number = h.voucher_number AND p2.deleted_at IS NOT NULL) AS soft_deleted_payment_count,
       floor(EXTRACT(EPOCH FROM (now() - h.in_date)) / 86400)::int AS days_since_sale
  FROM voucher_headers h
  LEFT JOIN users u ON u.user_number = h.user_code AND u.deleted_at IS NULL
  LEFT JOIN reps r ON r.user_id = u.id AND r.deleted_at IS NULL
  LEFT JOIN customers c ON c.customer_number = h.customer_number AND c.deleted_at IS NULL
  CROSS JOIN LATERAL (
    SELECT COALESCE(sum(p.amount), 0) AS settled,
           count(*) AS rows_present,
           COALESCE(string_agg(DISTINCT p.payment_type, ','), '') AS types,
           COALESCE(sum(p.amount) FILTER (WHERE p.payment_type = 'CREDIT'), 0) AS credit_amt
      FROM payments p
     WHERE p.voucher_number = h.voucher_number AND p.deleted_at IS NULL
  ) pay
 WHERE h.deleted_at IS NULL
   AND h.is_posted = true
   AND h.trans_kind = 'SALE'
   AND h.net_total::numeric > 0
   AND pay.settled::numeric < h.net_total::numeric - 0.001
 ORDER BY (h.net_total::numeric - pay.settled::numeric) DESC, h.in_date DESC
 LIMIT 200$chk$),
        ('discount_above_policy', 'خصم يتجاوز السياسة (أكثر من ١٥٪ من إجمالي السطر)', 'Discount above policy (line discounted over 15% of gross)', 'warn',
         $chk$SELECT h.voucher_number, h.in_date, t.id::text AS line_id, t.item_number, t.item_name,
       h.user_code, COALESCE(r.name_ar, u.name, h.user_code) AS rep_name,
       h.customer_number, COALESCE(c.name_ar, c.customer_name, c.name_en) AS customer_name,
       q.sell_qty, t.unit_price::numeric AS unit_price, round(g.gross, 3) AS gross,
       t.discount_value::numeric AS discount_value,
       round(100 * t.discount_value::numeric / g.gross, 2) AS discount_pct,
       (h.applied_offer_ids <> '[]'::jsonb) AS voucher_used_offers
  FROM voucher_headers h
  JOIN voucher_transactions t ON t.voucher_number = h.voucher_number AND t.deleted_at IS NULL
  LEFT JOIN users u ON u.user_number = h.user_code AND u.deleted_at IS NULL
  LEFT JOIN reps r ON r.user_id = u.id AND r.deleted_at IS NULL
  LEFT JOIN customers c ON c.customer_number = h.customer_number AND c.deleted_at IS NULL
  CROSS JOIN LATERAL (
    SELECT COALESCE(t.qty_of_unit, t.item_qty / NULLIF(t.unit_base_qty,0), t.item_qty)::numeric AS sell_qty
  ) q
  CROSS JOIN LATERAL (SELECT q.sell_qty * t.unit_price::numeric AS gross) g
 WHERE h.deleted_at IS NULL
   AND h.is_posted
   AND h.trans_kind = 'SALE'
   AND t.trans_kind = 'SALE'
   AND h.applied_offer_ids = '[]'::jsonb
   AND g.gross > 0
   AND t.discount_value::numeric > 0.15 * g.gross + 0.001
 ORDER BY discount_pct DESC, h.in_date DESC
 LIMIT 200$chk$),
        ('sale_outside_geofence', 'بيع مسجل على بعد أكثر من 500 متر من العميل', 'Sale recorded more than 500 m from the billed customer', 'warn',
         $chk$SELECT g.voucher_number, g.in_date, g.trans_kind, g.net_total, g.customer_number, g.customer_name,
       g.user_code, g.rep_name, g.sale_lat, g.sale_lng, g.customer_lat, g.customer_lng,
       g.customer_pin_self_seeded, round(g.distance_m::numeric, 1) AS distance_m
FROM (
    SELECT vh.voucher_number, vh.in_date, vh.trans_kind, vh.net_total::numeric AS net_total,
           vh.customer_number, c.customer_name, vh.user_code,
           coalesce(r.name_ar, u.name) AS rep_name,
           vh.sale_lat, vh.sale_lng,
           c.latitude::double precision AS customer_lat,
           c.longitude::double precision AS customer_lng,
           NOT EXISTS (SELECT 1 FROM voucher_headers p
                        WHERE p.customer_number = vh.customer_number
                          AND p.sale_lat IS NOT NULL
                          AND p.in_date < vh.in_date) AS customer_pin_self_seeded,
           2 * 6371008.8 * asin(least(1.0, sqrt(
                 power(sin(radians(c.latitude::double precision - vh.sale_lat) / 2), 2)
               + cos(radians(vh.sale_lat)) * cos(radians(c.latitude::double precision))
               * power(sin(radians(c.longitude::double precision - vh.sale_lng) / 2), 2)))) AS distance_m
      FROM voucher_headers vh
      JOIN customers c ON c.customer_number = vh.customer_number AND c.deleted_at IS NULL
      JOIN users u ON u.user_number = vh.user_code AND u.deleted_at IS NULL
      LEFT JOIN reps r ON r.user_id = u.id AND r.deleted_at IS NULL
     WHERE vh.deleted_at IS NULL
       AND vh.trans_kind = 'SALE'
       AND vh.is_posted = true
       AND vh.sale_lat IS NOT NULL AND vh.sale_lng IS NOT NULL
       AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL
       AND NOT (c.latitude = 0 AND c.longitude = 0)
       AND COALESCE(u.permissions, '[]'::jsonb) @> '["customers.requireProximity"]'::jsonb
) g
WHERE g.distance_m > 1000
ORDER BY g.distance_m DESC, g.in_date DESC
LIMIT 200$chk$),
        ('collection_not_deposited', 'تحصيلات مؤكدة منذ أكثر من 3 أيام ولم تُودَع بعد', 'Collections confirmed over 3 days ago and still not deposited', 'warn',
         $chk$SELECT c.id AS collection_id, c.collection_number, c.rep_id, r.code AS rep_code,
       COALESCE(r.name_en, r.name_ar) AS rep_name, u.user_number AS rep_user_number,
       c.customer_id, cu.customer_number,
       COALESCE(cu.name_en, cu.name_ar, cu.customer_name) AS customer_name,
       i.invoice_number, c.method, c.status,
       c.amount AS amount_fils, ROUND(c.amount::numeric / 1000, 3) AS amount_jod,
       c.collected_at, c.confirmed_at, c.deposited_at,
       chq.due_date AS cheque_due_date,
       ROUND(EXTRACT(EPOCH FROM (now() - c.collected_at)) / 86400.0, 1) AS days_held,
       CASE WHEN c.confirmed_at IS NULL THEN 'NEVER_CONFIRMED' ELSE 'CONFIRMED_NOT_DEPOSITED' END AS reason
  FROM collections c
  LEFT JOIN reps r ON r.id = c.rep_id AND r.deleted_at IS NULL
  LEFT JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
  LEFT JOIN customers cu ON cu.id = c.customer_id AND cu.deleted_at IS NULL
  LEFT JOIN invoices i ON i.id = c.invoice_id
  LEFT JOIN LATERAL (
    SELECT max(ch.due_date) AS due_date FROM cheques ch WHERE ch.collection_id = c.id
  ) chq ON TRUE
 WHERE c.deposited_at IS NULL
   AND c.status <> 'bounced'
   AND c.collected_at < now() - INTERVAL '3 days'
   AND (chq.due_date IS NULL OR chq.due_date <= current_date)
 ORDER BY c.collected_at ASC, c.amount DESC
 LIMIT 200$chk$),
        ('voucher_not_exported', 'سندات مُرحَّلة لم تصل إلى نظام ERP', 'Posted vouchers that never reached the ERP', 'warn',
         $chk$SELECT
  vh.voucher_number,
  vh.trans_kind,
  vh.in_date,
  vh.user_code,
  COALESCE(r.name_ar, r.name_en, u.name)                        AS rep_name,
  vh.customer_number,
  COALESCE(c.name_ar, c.name_en)                                AS customer_name,
  vh.net_total::numeric                                         AS net_total,
  CASE WHEN ob.id IS NOT NULL THEN 'STUCK_IN_OUTBOX' ELSE 'NEVER_QUEUED' END AS reason,
  ob.kind                                                       AS outbox_kind,
  ob.status                                                     AS outbox_status,
  ob.attempts                                                   AS outbox_attempts,
  ob.next_attempt_at                                            AS outbox_next_attempt_at,
  left(ob.error, 200)                                           AS outbox_error,
  round(EXTRACT(EPOCH FROM (now() - vh.in_date))::numeric / 86400.0, 1) AS age_days
FROM voucher_headers vh
LEFT JOIN users u
  ON u.user_number = vh.user_code
 AND u.deleted_at IS NULL
LEFT JOIN reps r
  ON r.user_id = u.id
 AND r.deleted_at IS NULL
LEFT JOIN customers c
  ON c.customer_number = vh.customer_number
 AND c.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT o.id, o.kind, o.status, o.attempts, o.next_attempt_at, o.error
  FROM erp_outbox o
  WHERE o.ref = vh.voucher_number
    AND o.kind IN ('SALE_INVOICE','SALES_RETURN','SALES_ORDER','STOCK_ADJUSTMENT','STOCK_TRANSFER')
    AND (o.status IN ('failed','dead_letter') OR (o.status = 'pending' AND (o.attempts > 0 OR o.next_attempt_at < now() - INTERVAL '15 minutes')))
  ORDER BY CASE o.status WHEN 'dead_letter' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, o.created_at
  LIMIT 1
) ob ON true
WHERE vh.deleted_at IS NULL
  AND vh.is_posted = true
  AND vh.trans_kind IN ('SALE','RETURN','ORDER','IN','OUT','TRANSFER')
  AND vh.voucher_number NOT LIKE 'ERP-%'
  AND (
        ob.id IS NOT NULL
     OR (
          (SELECT s.erp_sync_enabled FROM app_settings s ORDER BY s.id LIMIT 1) IS TRUE
      AND NOT EXISTS (
            SELECT 1 FROM erp_id_map m
            WHERE m.entity = 'voucher' AND m.local_id = vh.voucher_number
          )
      AND NOT EXISTS (
            SELECT 1 FROM erp_outbox o2
            WHERE o2.ref = vh.voucher_number
              AND o2.kind IN ('SALE_INVOICE','SALES_RETURN','SALES_ORDER','STOCK_ADJUSTMENT','STOCK_TRANSFER')
              AND o2.status = 'posted'
          )
        )
      )
ORDER BY
  CASE WHEN ob.status IN ('dead_letter','failed') THEN 0
       WHEN ob.status = 'pending' THEN 1
       ELSE 2 END,
  vh.in_date
LIMIT 200$chk$)
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_checks"`);
  }
}
