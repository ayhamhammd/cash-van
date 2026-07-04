#!/usr/bin/env node
/**
 * End-to-end check for the FlowVan side of the ERP Integration Hub.
 *
 * Simulates the Hub calling FlowVan's inbound webhook and exercises the full
 * inbound path against a RUNNING backend — signature verify (accept/reject),
 * timestamp skew, idempotent dedup, and the ops log — plus the settings config
 * round-trip. It does NOT need a live Hub (it plays the Hub's role).
 *
 * The outbound push (Van → Hub → ERP) needs a real Hub to receive it, so it is
 * only smoke-listed here, not asserted. See docs/RUNBOOK-connect-erp-hub.md.
 *
 * Usage:  node scripts/check-hub-integration.mjs
 *   env:  API=http://localhost:3100/api/v1  ADMIN_USER=admin  ADMIN_PASS=admin1234
 */
import { createHmac } from 'node:crypto';

const API = process.env.API ?? 'http://localhost:3100/api/v1';
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'admin1234';
const SECRET = `whsec_check_${Date.now().toString(36)}`;

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  (cond ? pass++ : fail++);
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function sign(secret, ts, rawBody) {
  return 'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
}

async function jsonOrNull(res) {
  try { return await res.json(); } catch { return null; }
}

async function main() {
  console.log(`\nHub integration check → ${API}\n`);

  // 1. Auth
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userNumber: ADMIN_USER, password: ADMIN_PASS }),
  });
  const token = (await jsonOrNull(login))?.data?.accessToken;
  ok('admin login', !!token);
  if (!token) return finish();
  const auth = { Authorization: `Bearer ${token}` };

  // 2. Settings round-trip: set a (test) webhook secret so the receiver enforces
  //    signatures. `enabled:false` keeps the outbound path off (no side effects).
  const patch = await fetch(`${API}/settings/hub`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false, webhookSecret: SECRET }),
  });
  const hubView = await jsonOrNull(patch);
  ok('PATCH /settings/hub (set webhook secret)', patch.status === 200,
    `last4=${hubView?.data?.webhookSecretLast4 ?? hubView?.webhookSecretLast4 ?? '?'}`);

  // 3. A correctly-signed inventory.stock_changed webhook → 200 received.
  const evtId = `evt_check_${Date.now()}`;
  const body = JSON.stringify({
    id: evtId,
    eventType: 'inventory.stock_changed',
    entityType: 'STOCK_MOVEMENT',
    data: { skuId: 'sku-check', warehouseId: 'wh-check', quantityChanged: 5, newStockLevel: 105 },
  });
  const send = (ts, sig) => fetch(`${API}/webhooks/hub`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Event-Type': 'inventory.stock_changed',
      'X-Hub-Timestamp': String(ts),
      'X-Hub-Signature': sig,
    },
    body,
  });

  const now = Math.floor(Date.now() / 1000);
  const r1 = await send(now, sign(SECRET, now, body));
  const b1 = await jsonOrNull(r1);
  ok('signed webhook accepted', r1.status === 200 && b1?.received === true, `status=${r1.status}`);

  // 4. Same event re-delivered → idempotent duplicate.
  const now2 = Math.floor(Date.now() / 1000);
  const r2 = await send(now2, sign(SECRET, now2, body));
  const b2 = await jsonOrNull(r2);
  ok('re-delivery deduped', r2.status === 200 && b2?.duplicate === true, `duplicate=${b2?.duplicate}`);

  // 5. Bad signature → 401.
  const now3 = Math.floor(Date.now() / 1000);
  const r3 = await send(now3, sign('wrong-secret', now3, body));
  ok('bad signature rejected (401)', r3.status === 401, `status=${r3.status}`);

  // 6. Stale timestamp (> 5 min skew) but correctly signed → 401.
  const stale = Math.floor(Date.now() / 1000) - 600;
  const r4 = await send(stale, sign(SECRET, stale, body));
  ok('stale timestamp rejected (401)', r4.status === 401, `status=${r4.status}`);

  // 7. Ops log lists the event.
  const list = await fetch(`${API}/erp/hub-webhooks`, { headers: auth });
  const rows = (await jsonOrNull(list))?.data ?? [];
  const found = Array.isArray(rows) && rows.some((e) => e.eventType === 'inventory.stock_changed');
  ok('event visible in ops log (GET /erp/hub-webhooks)', list.status === 200 && found,
    `rows=${Array.isArray(rows) ? rows.length : '?'}`);

  finish();
}

function finish() {
  console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (SECRET) console.log(`Note: a TEST webhook secret was set on app_settings. Set your real one in\nSettings → Integration Hub before going live.\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('check crashed:', e?.message ?? e);
  process.exit(1);
});
