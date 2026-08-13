-- Erase every TRANSACTION from cash van, keeping the master data.
--
-- Removed: vouchers (sales / returns / orders), their lines and payments,
-- collections and cheques, office invoices and their lines, credit notes, tax
-- ledger + JoFotara log, cash-account movements, salesman settlements, offer
-- redemptions, the sync inbox and the pending ERP push queue. Customer debt and
-- credit balances are zeroed.
--
-- KEPT: customers, items, units, prices, offers, reps, users, warehouses,
-- regions, routes, van stock, visits, and the ERP id mappings for master data.
--
-- THIS CANNOT BE UNDONE. Take a dump first:
--     docker exec cashvan-db pg_dump -U cashvan cashvan > backup.sql
--
-- Run:
--     psql -U cashvan -d cashvan -f reset-transactions.sql
--
-- STOP THE API FIRST (docker compose stop app). A running server holds vouchers
-- in flight and will write new rows the moment this finishes; worse, the vans
-- may be mid-sync and their retry would re-post everything deleted here.

\set ON_ERROR_STOP on

BEGIN;

-- What is about to go, so the output is a record of what was actually removed.
SELECT 'BEFORE' AS stage,
       (SELECT count(*) FROM voucher_headers)  AS vouchers,
       (SELECT count(*) FROM voucher_transactions) AS voucher_lines,
       (SELECT count(*) FROM payments)         AS payments,
       (SELECT count(*) FROM collections)      AS collections,
       (SELECT count(*) FROM invoices)         AS invoices,
       (SELECT count(*) FROM credit_notes)     AS credit_notes,
       (SELECT count(*) FROM customers WHERE total_debt <> 0 OR total_credit <> 0) AS customers_with_balance;

-- One TRUNCATE for every document table at once.
--
-- Deliberately no CASCADE: Postgres refuses to truncate a table that something
-- outside this list still references, which is exactly the check we want. If a
-- future table starts pointing at vouchers and is missing here, this errors and
-- rolls back rather than quietly dropping rows nobody meant to touch.
TRUNCATE TABLE
  voucher_transactions,
  voucher_headers,
  payments,
  payment_cheques,
  cheques,
  collections,
  invoice_lines,
  invoice_approvals,
  credit_note_lines,
  credit_notes,
  invoices,
  tax_ledger_entries,
  jofotara_submission_log,
  account_transactions,
  salesman_settlement,
  offer_redemptions,
  voucher_inbox,
  erp_outbox;

-- Customer balances. These are stored totals, not derived — deleting the
-- documents does NOT clear them, so they are zeroed explicitly. credit_limit is
-- left alone: it is a setting, not a balance.
UPDATE customers
   SET total_debt = 0,
       total_credit = 0,
       updated_at = now()
 WHERE total_debt <> 0 OR total_credit <> 0;

-- Release anyone the credit engine had blocked over a debt that no longer exists.
UPDATE customers
   SET credit_hold = false,
       updated_at = now()
 WHERE credit_hold = true;

-- Document-level ERP mappings only. 'customer', 'item', 'category' and 'rep'
-- rows are how the two systems recognise the same master record; deleting those
-- would make the next sync create duplicates of every customer and product.
DELETE FROM erp_id_map
 WHERE entity IN ('voucher', 'movement', 'receipt', 'receipts');

SELECT 'AFTER' AS stage,
       (SELECT count(*) FROM voucher_headers)  AS vouchers,
       (SELECT count(*) FROM voucher_transactions) AS voucher_lines,
       (SELECT count(*) FROM payments)         AS payments,
       (SELECT count(*) FROM collections)      AS collections,
       (SELECT count(*) FROM invoices)         AS invoices,
       (SELECT count(*) FROM credit_notes)     AS credit_notes,
       (SELECT count(*) FROM customers WHERE total_debt <> 0 OR total_credit <> 0) AS customers_with_balance,
       (SELECT count(*) FROM customers)        AS customers_kept,
       (SELECT count(*) FROM item_cart)        AS items_kept,
       (SELECT count(*) FROM reps)             AS reps_kept;

COMMIT;

-- OPTIONAL, not part of the reset above.
--
-- Document numbering continues from where it stopped (INV-4000031, ...). Run
-- this only if numbering should restart from 1 — and only when the ERP has been
-- cleared too, or the two systems will disagree about which INV-4000001 is which:
--
--   UPDATE voucher_counters SET last_number = 0;
--
-- Van stock is NOT reset here. Quantities still reflect every sale that was just
-- deleted, so if this is a fresh start the vans should be re-loaded from the
-- dashboard rather than having the numbers edited by hand.
