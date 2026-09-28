'use strict';
// WRITES: gets refused-for-stock vouchers into the ERP. Preview by default.
//
// For each van, transfers from the main warehouse EXACTLY what its refused sales
// are short of in the ERP (needed minus what the ERP van already holds), waits for
// the ERP to book the transfers, re-sends the refused sales (up to 3 rounds), runs
// Export all, and reports what is left. Stops without creating anything if the ERP
// snapshot is incomplete, an ERP warehouse name matches no VanFlow store, or there
// is not exactly one main warehouse. Run erp-check.js first.
//
//   docker cp .\erp-fix-stuck-stock.js cashvan-api:/tmp/erp-fix-stuck-stock.js
//   docker exec -e 'ADMIN_USER=admin' -e 'ADMIN_PASS=<password>' cashvan-api node /tmp/erp-fix-stuck-stock.js
//   ...same with -e 'APPLY=1' to do it; -e 'VANS=3,8' limits it to those vans.
// Do not run APPLY twice back to back: a second run before the first transfers
// reach the ERP would transfer the same shortfall again.
const pg = require(process.env.PG_PATH || '/app/node_modules/pg');
const API = process.env.API_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/v1';
const APPLY = process.env.APPLY === '1';
const ONLY = (process.env.VANS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const Q = String.fromCharCode(39);
const SHORT = Q + 'INSUFFICIENT_STOCK%' + Q;
const NEED_SQL = 'SELECT vt.store_number AS van, vt.item_number, max(vt.item_name) AS item, ' +
  'COALESCE(vt.stock_unit_code, ' + Q + Q + ') AS pool, vt.item_unit_id, COALESCE(vt.unit_base_qty, 1) AS factor, ' +
  'sum(vt.item_qty)::float AS need FROM erp_outbox o JOIN voucher_transactions vt ON vt.voucher_number = o.ref ' +
  'WHERE o.status <> ' + Q + 'posted' + Q + ' AND o.error LIKE ' + SHORT + ' ' +
  'GROUP BY vt.store_number, vt.item_number, COALESCE(vt.stock_unit_code, ' + Q + Q + '), vt.item_unit_id, COALESCE(vt.unit_base_qty, 1) ' +
  'ORDER BY vt.store_number, vt.item_number';

let db;
let token;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function now() { return new Date().toTimeString().slice(0, 8); }
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
async function q(sql) { return (await db.query(sql)).rows; }

async function queueSummary() {
  return q('SELECT status, split_part(COALESCE(error, ' + Q + 'OK' + Q + '), ' + Q + ':' + Q + ', 1) AS reason, count(*)::int AS n ' +
    'FROM erp_outbox WHERE status <> ' + Q + 'posted' + Q + ' GROUP BY 1, 2 ORDER BY 1, 2');
}
function printSummary(rows) {
  if (!rows.length) { console.log('  queue: nothing waiting - everything is posted'); return; }
  rows.forEach(function (r) { console.log('  ' + pad(r.status, 12) + pad(r.reason, 26) + r.n); });
}

// Wait until every queued row has had its turn (no untried rows left), printing progress.
async function waitForQueue(label, maxMinutes) {
  const until = Date.now() + maxMinutes * 60000;
  for (;;) {
    const untried = (await q('SELECT count(*)::int AS n FROM erp_outbox WHERE status = ' + Q + 'pending' + Q + ' AND error IS NULL'))[0].n;
    const posted = (await q('SELECT count(*)::int AS n FROM erp_outbox WHERE status = ' + Q + 'posted' + Q + ' AND updated_at > now() - interval ' + Q + '3 hours' + Q))[0].n;
    console.log('  ' + now() + ' ' + label + ': ' + untried + ' still waiting their turn, ' + posted + ' posted in the last 3h');
    if (untried === 0) return;
    if (Date.now() > until) { console.log('  still going after ' + maxMinutes + ' min - carrying on; they will keep sending in the background.'); return; }
    await sleep(20000);
  }
}

// The exact shortfall per van and item: what the refused sales need, minus what the ERP van holds.
async function shortfall() {
  const mains = await q('SELECT wh_number FROM warehouses WHERE is_main AND deleted_at IS NULL');
  if (mains.length !== 1) throw new Error('Expected exactly ONE main warehouse, found ' + mains.length + ' - stopping.');
  const mainStore = mains[0].wh_number;
  const need = (await q(NEED_SQL)).filter(function (r) { return !ONLY.length || ONLY.indexOf(r.van) >= 0; });
  if (!need.length) return { mainStore: mainStore, vouchers: [], total: 0 };
  const local = await q('SELECT stock_number, item_number, stock_unit_code, SUM(qty)::float AS qty FROM item_balance GROUP BY 1, 2, 3');
  const drift = await call('GET', '/erp/sync/drift');
  if (!drift.complete) throw new Error('The ERP stock snapshot came back incomplete - stopping rather than guess.');
  if ((drift.unmatchedWarehouses || []).length) {
    throw new Error('These ERP warehouses match no VanFlow store by name, so their stock cannot be read: ' +
      drift.unmatchedWarehouses.join(', ') + ' - fix the names first. Nothing was created.');
  }
  const erpByPool = new Map();
  (drift.rows || []).forEach(function (r) { erpByPool.set(r.storeNumber + '|' + r.itemNumber + '|' + r.stockUnitCode, Number(r.erpQty) || 0); });
  const localByPool = new Map();
  local.forEach(function (r) { localByPool.set(r.stock_number + '|' + r.item_number + '|' + r.stock_unit_code, Number(r.qty) || 0); });

  const byVan = new Map();
  need.forEach(function (r) {
    const key = r.van + '|' + r.item_number + '|' + r.pool;
    // No drift row for a pool means the ERP holds exactly what VanFlow holds.
    const erpHas = erpByPool.has(key) ? erpByPool.get(key) : (localByPool.get(key) || 0);
    const short = Math.round((r.need - Math.max(erpHas, 0)) * 1000) / 1000;
    if (!byVan.has(r.van)) byVan.set(r.van, []);
    byVan.get(r.van).push({ r: r, erpHas: erpHas, short: short });
  });
  let total = 0;
  const vouchers = [];
  byVan.forEach(function (rows, van) {
    console.log('\n  VAN ' + van + '  (from main store ' + mainStore + ')');
    console.log('  ' + pad('item', 16) + pad('needed', 9) + pad('erp has', 9) + 'transfer   name');
    const lines = [];
    rows.forEach(function (x) {
      const factor = Number(x.r.factor) || 1;
      const units = x.short > 0 ? Math.ceil(x.short / factor) : 0;
      console.log('  ' + pad(x.r.item_number, 16) + pad(x.r.need, 9) + pad(x.erpHas, 9) + pad(units * factor, 11) + (x.r.item || ''));
      if (units <= 0) return;
      total += units * factor;
      const line = { itemNumber: x.r.item_number, itemName: x.r.item || x.r.item_number, itemQty: String(units), unitPrice: '0',
        unitBaseQty: factor, fromStoreNumber: mainStore, toStoreNumber: van, storeNumber: mainStore };
      if (x.r.item_unit_id) line.itemUnitId = x.r.item_unit_id;
      lines.push(line);
    });
    if (lines.length) {
      vouchers.push({ transKind: 'TRANSFER', userCode: process.env.ADMIN_USER, isPosted: true,
        notes: 'ERP stock top-up for refused sales of van ' + van, transactions: lines });
    }
  });
  return { mainStore: mainStore, vouchers: vouchers, total: total };
}

// Create the transfers, then wait until the ERP has booked every one of them.
async function transfer(vouchers) {
  const made = [];
  for (const v of vouchers) {
    try {
      const res = await call('POST', '/vouchers', v);
      made.push(res.voucherNumber);
      console.log('  CREATED ' + res.voucherNumber + ' -> van ' + v.transactions[0].toStoreNumber + ' (' + v.transactions.length + ' items)');
    } catch (e) {
      console.log('  FAILED van ' + v.transactions[0].toStoreNumber + ': ' + e.message);
    }
  }
  if (!made.length) return false;
  const list = made.map(function (n) { return Q + n + Q; }).join(',');
  const until = Date.now() + 10 * 60000;
  for (;;) {
    const rows = await q('SELECT ref, status, COALESCE(error, ' + Q + Q + ') AS error FROM erp_outbox WHERE ref IN (' + list + ')');
    const done = rows.filter(function (r) { return r.status === 'posted'; }).length;
    const bad = rows.filter(function (r) { return r.status === 'dead_letter' || r.status === 'failed'; });
    console.log('  ' + now() + ' transfers in the ERP: ' + done + ' of ' + made.length);
    if (bad.length) { bad.forEach(function (r) { console.log('  TRANSFER ' + r.ref + ' refused by the ERP: ' + r.error); }); return false; }
    if (done === made.length) return true;
    if (Date.now() > until) { console.log('  transfers not in the ERP after 10 min - stopping here.'); return false; }
    await sleep(10000);
  }
}

async function main() {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) throw new Error('Set ADMIN_USER and ADMIN_PASS');
  token = (await call('POST', '/auth/login', { userNumber: process.env.ADMIN_USER, password: process.env.ADMIN_PASS })).accessToken;
  if (!token) throw new Error('Login returned no token');
  db = new pg.Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  await db.connect();

  console.log('=== BEFORE ===');
  printSummary(await queueSummary());

  for (let round = 1; round <= 3; round++) {
    console.log('\n=== ROUND ' + round + ': stock the refused sales are short of ===');
    const s = await shortfall();
    console.log('\n  total to transfer: ' + s.total + ' pieces in ' + s.vouchers.length + ' transfer(s)');
    if (!APPLY) {
      const pending = await call('GET', '/erp/export/pending');
      console.log('\n  export all would also send: ' + (pending.vouchers || []).length + ' voucher(s), ' + (pending.collections || []).length + ' collection(s)');
      console.log('\nPREVIEW ONLY - nothing was changed. Run again with APPLY=1 to do it.');
      await db.end();
      return;
    }
    if (s.vouchers.length) {
      console.log('');
      if (!(await transfer(s.vouchers))) { console.log('Stopping: fix the transfer problem above, then run this again.'); break; }
    }
    const requeued = (await q('UPDATE erp_outbox SET status = ' + Q + 'pending' + Q + ', attempts = 0, next_attempt_at = now(), error = NULL, updated_at = now() ' +
      'WHERE status IN (' + Q + 'dead_letter' + Q + ', ' + Q + 'failed' + Q + ', ' + Q + 'pending' + Q + ') AND error LIKE ' + SHORT + ' RETURNING 1')).length;
    console.log('\n  re-sent ' + requeued + ' refused sale(s) to the ERP');
    await waitForQueue('sending', 25);
    const stillShort = (await q('SELECT count(*)::int AS n FROM erp_outbox WHERE status <> ' + Q + 'posted' + Q + ' AND error LIKE ' + SHORT))[0].n;
    if (stillShort === 0 || s.vouchers.length === 0) break;
    console.log('  ' + stillShort + ' sale(s) still short of stock - another round');
  }

  if (APPLY) {
    console.log('\n=== EXPORT ALL (vouchers and collections never sent) ===');
    const r = await call('POST', '/erp/export/all');
    console.log('  queued ' + (r.vouchers || 0) + ' voucher(s), ' + (r.collections || 0) + ' collection(s)' +
      (r.chequesIncomplete ? ', held back ' + r.chequesIncomplete + ' cheque(s) missing a due date' : ''));
    await waitForQueue('exporting', 25);

    console.log('\n=== AFTER ===');
    printSummary(await queueSummary());
    const left = await q('SELECT o.kind, o.ref, o.status, left(COALESCE(o.error, ' + Q + Q + '), 110) AS error FROM erp_outbox o ' +
      'WHERE o.status <> ' + Q + 'posted' + Q + ' ORDER BY o.status, o.ref LIMIT 40');
    if (left.length) {
      console.log('\n  still not in the ERP (first 40):');
      left.forEach(function (r) { console.log('  ' + pad(r.kind, 16) + pad(r.ref.slice(0, 36), 38) + pad(r.status, 12) + r.error); });
    }
    console.log('\nDone. When nothing above is left, run the stock reconcile from the dashboard.');
  }
  await db.end();
}
main().catch(function (e) { console.error('ERROR: ' + e.message); process.exit(1); });
