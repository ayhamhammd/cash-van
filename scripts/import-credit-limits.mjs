/**
 * Bulk-update customer credit limits from a CSV.
 *
 * Goes through the cash-van API rather than straight into the database, on
 * purpose: CustomersService.update() emits `erp.customer.updated`, which the ERP
 * sync listener turns into a push. One pass therefore updates BOTH systems. A
 * direct SQL UPDATE would change cash-van only and leave the ERP silently
 * disagreeing — the kind of split that surfaces weeks later as a credit block
 * nobody can explain.
 *
 * CSV columns: customerNumber,creditLimit,name   (name is for the log only)
 *
 *   node scripts/import-credit-limits.mjs --file credit-limits.csv \
 *        --api http://77.245.5.113:3002/api/v1 --token "<jwt>" [--apply]
 *
 * Without --apply it is a DRY RUN: it reports exactly what would change and
 * touches nothing. Run it that way first — the report is the review step.
 */

import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
    return acc;
  }, []),
);

const FILE = args.file ?? 'credit-limits.csv';
const API = (args.api ?? 'http://localhost:3100/api/v1').replace(/\/+$/, '');
const TOKEN = args.token;
const APPLY = args.apply === true || args.apply === 'true';

if (!TOKEN) {
  console.error(
    'Missing --token. Sign in to the dashboard, then copy the accessToken\n' +
      '(DevTools > Application > Cookies, or the login response).',
  );
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN}`,
};

/** Minimal CSV reader: these fields are numbers and codes, never quoted text. */
function readCsv(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const cols = lines[0].split(',').map((c) => c.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? '').trim()]));
  });
}

async function api(path, init) {
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body?.message ?? body?.error ?? res.statusText;
    throw new Error(`${res.status} ${Array.isArray(msg) ? msg.join(', ') : msg}`);
  }
  return body?.data ?? body;
}

/**
 * Every customer, keyed by number.
 *
 * Fetched in one pass rather than searched per row: 98 lookups against a live
 * server is 98 chances to time out halfway through a half-applied import.
 */
async function loadCustomers() {
  const byNumber = new Map();
  let offset = 0;
  for (;;) {
    const page = await api(`/customers?limit=200&offset=${offset}`);
    const items = page.items ?? page;
    if (!items?.length) break;
    for (const c of items) byNumber.set(String(c.customerNumber), c);
    if (items.length < 200) break;
    offset += 200;
  }
  return byNumber;
}

const rows = readCsv(FILE);
console.log(`${rows.length} rows from ${FILE}`);
console.log(APPLY ? '*** APPLYING CHANGES ***' : '--- DRY RUN (pass --apply to write) ---');

let customers;
try {
  customers = await loadCustomers();
} catch (e) {
  // The two ways this realistically fails both have a clear remedy, and a raw
  // stack trace hides both of them.
  if (String(e.message).startsWith('401')) {
    console.error('\nThe token was rejected. Sign in again and copy a fresh one —');
    console.error('these expire after 12 hours.');
  } else {
    console.error(`\nCould not read customers from ${API}`);
    console.error(`  ${e.message}`);
    console.error('Check the API address and that the server is reachable.');
  }
  process.exit(1);
}
console.log(`${customers.size} customers on the server\n`);

const missing = [];
const unchanged = [];
const planned = [];
const failed = [];

for (const row of rows) {
  const number = row.customerNumber;
  const target = Number(row.creditLimit);
  if (!Number.isFinite(target)) {
    failed.push({ number, reason: `credit limit "${row.creditLimit}" is not a number` });
    continue;
  }
  const cust = customers.get(number);
  if (!cust) {
    missing.push({ number, name: row.name });
    continue;
  }
  const current = Number(cust.creditLimit ?? 0);
  if (current === target) {
    unchanged.push(number);
    continue;
  }
  planned.push({ id: cust.id, number, name: row.name, from: current, to: target });
}

for (const p of planned) {
  console.log(`${p.number.padEnd(8)} ${String(p.from).padStart(10)} -> ${String(p.to).padStart(10)}  ${p.name}`);
  if (!APPLY) continue;
  try {
    // String, not number: creditLimit is a numeric column and the DTO carries it
    // as a string so no precision is lost on the way through JSON.
    await api(`/customers/${p.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ creditLimit: String(p.to) }),
    });
  } catch (e) {
    failed.push({ number: p.number, reason: e.message });
  }
}

const applied = APPLY ? planned.length - failed.filter((f) => f.reason).length : 0;
console.log('\n---');
console.log(`to change : ${planned.length}`);
console.log(`unchanged : ${unchanged.length}`);
console.log(`not found : ${missing.length}`);
console.log(`failed    : ${failed.length}`);
if (APPLY) console.log(`applied   : ${Math.max(0, applied)}`);

if (missing.length) {
  console.log('\nNot found on the server (no customer with that number):');
  for (const m of missing) console.log(`  ${m.number}  ${m.name}`);
}
if (failed.length) {
  console.log('\nFailed:');
  for (const f of failed) console.log(`  ${f.number}  ${f.reason}`);
}
if (!APPLY && planned.length) {
  console.log('\nNothing was written. Re-run with --apply to make these changes.');
}
