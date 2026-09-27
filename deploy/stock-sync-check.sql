-- Stock sync check — READ ONLY. Run against the cash-van database of a server:
--   docker exec -i <cashvan-db> psql -U cashvan -d <db> -P pager=off < stock-sync-check.sql
--
-- Lists every place a quantity can have been dropped between the handset,
-- cash-van and the ERP. Each section is a queue of documents that happened in
-- the field and did not fully arrive. See STOCK-SYNC-RECOVERY.md for what to do
-- with each.

SET default_transaction_read_only = on;

\echo
\echo '== 1. Handset documents that never became vouchers (voucher_inbox)'
\echo '   The sale/return happened; cash-van and the ERP never recorded it.'
SELECT status, type, COUNT(*) AS docs, MIN(created_at)::date AS oldest, MAX(created_at)::date AS newest
  FROM voucher_inbox
 WHERE status IN ('failed', 'rejected', 'dead_letter', 'pending')
 GROUP BY 1, 2 ORDER BY 1, 2;

\echo
\echo '== 1b. ...and why'
SELECT status, LEFT(COALESCE(error, ''), 150) AS reason, COUNT(*) AS docs
  FROM voucher_inbox
 WHERE status IN ('failed', 'rejected', 'dead_letter')
 GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20;

\echo
\echo '== 2. Vouchers cash-van holds that the ERP never received (erp_outbox)'
\echo '   Stock left the van here and not in the ERP. dead_letter = given up on.'
SELECT kind, status, COUNT(*) AS docs, MIN(created_at)::date AS oldest, MAX(created_at)::date AS newest
  FROM erp_outbox
 WHERE status IN ('pending', 'failed', 'dead_letter')
 GROUP BY 1, 2 ORDER BY 1, 2;

\echo
\echo '== 2b. ...and why'
SELECT kind, status, LEFT(COALESCE(error, ''), 150) AS reason, COUNT(*) AS docs
  FROM erp_outbox
 WHERE status IN ('pending', 'failed', 'dead_letter')
 GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 20;

\echo
\echo '== 3. Posted van documents with NO outbox row at all (should be zero)'
SELECT vh.trans_kind, COUNT(*) AS docs
  FROM voucher_headers vh
 WHERE vh.is_posted = TRUE
   AND vh.trans_kind IN ('SALE', 'RETURN', 'IN', 'OUT', 'TRANSFER')
   AND vh.voucher_number NOT LIKE 'ERP-%'
   AND NOT EXISTS (SELECT 1 FROM erp_outbox o WHERE o.ref = vh.voucher_number)
 GROUP BY 1;

\echo
\echo '== 4. Approved requests saved as DRAFTS (before the 23 Sep fix)'
\echo '   The handset committed these as sales; the server moved no stock and exported nothing.'
SELECT ar.type, vh.voucher_number, vh.user_code, vh.in_date::date, ar.decided_at::date AS approved
  FROM approval_requests ar
  JOIN voucher_headers vh ON vh.voucher_number = ar.result_voucher
 WHERE ar.status = 'approved' AND vh.is_posted = FALSE
 ORDER BY vh.in_date;

\echo
\echo '== 5. ERP movement feed per store (last_skipped > 0 = movements stepped over and lost)'
SELECT entity, updated_since, last_status, last_count, last_skipped,
       LEFT(COALESCE(last_error, ''), 100) AS last_error
  FROM erp_sync_cursor
 WHERE entity LIKE 'movements:%'
 ORDER BY entity;

\echo
\echo '== 6. Salesmen with no van warehouse (their stock is read from the legacy van_stock table)'
SELECT r.code, r.name_ar FROM reps r WHERE r.van_id IS NULL ORDER BY r.code;
