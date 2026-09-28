'use strict';
// READ-ONLY conflict check between VanFlow and the ERP. Changes nothing.
//
// Shows: what "Match ERP" would correct or skip right now (its dry run), every
// document not yet in the ERP by reason, which documents block which store, and
// phone documents the server never accepted. Safe to run any time.
//
// On a client server (PowerShell), after copying this file next to the compose files:
//   docker cp .\erp-check.js cashvan-api:/tmp/erp-check.js
//   docker exec -e 'ADMIN_USER=admin' -e 'ADMIN_PASS=<password>' cashvan-api node /tmp/erp-check.js
const pg = require(process.env.PG_PATH || '/app/node_modules/pg');
const API = process.env.API_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/v1';
const Q = String.fromCharCode(39);
let token;
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function unwrap(j) { return j && j.success !== undefined && j.data !== undefined ? j.data : j; }
async function call(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(method + ' ' + path + ' -> ' + r.status + ' ' + JSON.stringify(j.message || j));
  return unwrap(j);
}
async function main() {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) throw new Error('Set ADMIN_USER and ADMIN_PASS');
  token = (await call('POST', '/auth/login', { userNumber: process.env.ADMIN_USER, password: process.env.ADMIN_PASS })).accessToken;
  const db = new pg.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  await db.connect();
  await db.query('SET default_transaction_read_only = on');

  console.log('=== 1. STOCK: what Match ERP would do right now (dry run - nothing is written) ===');
  try {
    const r = await call('POST', '/erp/sync/reconcile-stock?dryRun=1');
    console.log('  ERP rows read: ' + r.erpRowsFetched + ' of ' + r.erpRowsReported + ' | items compared: ' + r.poolsCompared + ' | differing: ' + r.poolsDrifted);
    if (r.unresolvedSkus) console.log('  WARNING ' + r.unresolvedSkus + ' ERP item(s) have no VanFlow item - their stock cannot be compared');
    if ((r.unmatchedWarehouses || []).length) console.log('  WARNING ERP warehouses with no matching VanFlow store: ' + r.unmatchedWarehouses.join(', '));
    if (!(r.applied || []).length && !(r.skipped || []).length) console.log('  OK - every store matches the ERP');
    (r.applied || []).forEach(function (a) { console.log('  WOULD CORRECT  ' + pad(a.storeNumber, 12) + pad(a.storeName || '', 26) + a.pools + ' item(s), ' + a.absQtyCorrected + ' piece(s)'); });
    (r.skipped || []).forEach(function (k) { console.log('  BLOCKED        ' + pad(k.storeNumber, 12) + k.poolsDrifted + ' differing item(s) - ' + k.reason); });
  } catch (e) { console.log('  could not run the stock check: ' + e.message); }

  console.log('\n=== 2. DOCUMENTS NOT IN THE ERP (by reason) ===');
  const out = (await db.query('SELECT kind, status, split_part(COALESCE(error, ' + Q + 'waiting its turn' + Q + '), ' + Q + ':' + Q + ', 1) AS reason, count(*)::int AS n ' +
    'FROM erp_outbox WHERE status <> ' + Q + 'posted' + Q + ' GROUP BY 1, 2, 3 ORDER BY 4 DESC')).rows;
  if (!out.length) console.log('  OK - nothing waiting, everything is in the ERP');
  out.forEach(function (r) { console.log('  ' + pad(r.kind, 18) + pad(r.status, 12) + pad(r.n, 6) + r.reason); });

  console.log('\n=== 3. BLOCKING DOCUMENTS PER STORE (why Match ERP skips it) ===');
  const blk = (await db.query('SELECT COALESCE(s.store_number, ' + Q + '(no lines - blocks ALL)' + Q + ') AS store, o.ref, o.status, left(COALESCE(o.error, ' + Q + 'waiting its turn' + Q + '), 100) AS error ' +
    'FROM erp_outbox o LEFT JOIN voucher_transactions vt ON vt.voucher_number = o.ref ' +
    'LEFT JOIN LATERAL (VALUES (vt.store_number), (vt.from_store_number), (vt.to_store_number)) AS s(store_number) ON TRUE ' +
    'WHERE o.status IN (' + Q + 'pending' + Q + ', ' + Q + 'failed' + Q + ', ' + Q + 'dead_letter' + Q + ') ' +
    'AND o.kind IN (' + Q + 'SALE_INVOICE' + Q + ', ' + Q + 'SALES_RETURN' + Q + ', ' + Q + 'STOCK_ADJUSTMENT' + Q + ', ' + Q + 'STOCK_TRANSFER' + Q + ') ' +
    'AND (s.store_number IS NOT NULL OR vt.voucher_number IS NULL) GROUP BY 1, 2, 3, 4 ORDER BY 1, 2 LIMIT 60')).rows;
  if (!blk.length) console.log('  OK - no store is blocked');
  blk.forEach(function (r) { console.log('  ' + pad(r.store, 12) + pad(r.ref, 24) + pad(r.status, 12) + r.error); });

  console.log('\n=== 4. PHONE DOCUMENTS THE SERVER NEVER ACCEPTED ===');
  const inbox = (await db.query('SELECT type, COALESCE(assigned_number, client_number, client_ref) AS doc, user_code, status, left(COALESCE(error, ' + Q + Q + '), 100) AS error ' +
    'FROM voucher_inbox WHERE status <> ' + Q + 'posted' + Q + ' ORDER BY created_at LIMIT 40')).rows;
  if (!inbox.length) console.log('  OK - every phone document was accepted');
  inbox.forEach(function (r) { console.log('  ' + pad(r.type, 10) + pad(r.doc, 24) + pad(r.user_code, 8) + pad(r.status, 12) + r.error); });

  console.log('\nRead-only check finished. Nothing was changed.');
  await db.end();
}
main().catch(function (e) { console.error('ERROR: ' + e.message); process.exit(1); });
