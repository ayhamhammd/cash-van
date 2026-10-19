/**
 * A customer's own server, with no control plane anywhere.
 *
 * Everything the 7CRM work added has to be INVISIBLE here. These sites were
 * installed before the control plane existed, they have no licence key and no
 * company code, and they cannot reach us — so the only acceptable outcome is
 * that they carry on exactly as they did.
 *
 * Run against docker-compose.onprem.yml:
 *
 *   docker compose -f docker-compose.onprem.yml up -d --build
 *   node scripts/e2e/onprem.mjs
 */

const VAN = 'http://localhost:3600/api/v1';
const ERP = 'http://localhost:3700';

const ADMIN = process.env.ONPREM_ADMIN ?? 'admin';
const PASS = process.env.ONPREM_PASSWORD ?? 'admin1234';

let pass = 0, fail = 0;
const failures = [];
const ok = (n, x = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${x ? ` \x1b[90m${x}\x1b[0m` : ''}`); };
const bad = (n, d) => { fail++; failures.push(n); console.log(`  \x1b[31m✗\x1b[0m ${n}`); if (d) console.log(`    \x1b[31m${String(d).slice(0, 400)}\x1b[0m`); };
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function call(base, path, o = {}) {
  const res = await fetch(`${base}${path}`, {
    method: o.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.key ? { 'x-license-key': o.key } : {}),
      ...(o.secret ? { 'x-internal-secret': o.secret } : {}),
    },
    ...(o.body ? { body: JSON.stringify(o.body) } : {}),
    redirect: 'manual',
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, ok: res.ok, body: parsed, data: parsed.data ?? parsed, text };
}

const s = {};

async function main() {
  step('1 · Signing in with no licence key at all');

  const login = await call(VAN, '/auth/login', {
    method: 'POST',
    body: { userNumber: ADMIN, password: PASS },
  });
  if (login.ok && login.data.accessToken) {
    s.van = login.data.accessToken;
    ok('the seeded admin signs in, no key sent', ADMIN);
  } else {
    return bad('sign in without a key', JSON.stringify(login.body).slice(0, 300));
  }

  const lic = await call(VAN, '/auth/license', { key: '' });
  if (lic.data?.licensingEnabled === false) {
    ok('the app reports licensing is off', 'nothing to phone home to');
  } else {
    bad('licensing should be off with no CRM', JSON.stringify(lic.data));
  }

  // A key typed in by mistake, or left over in a browser, must not lock anyone
  // out of a machine that has no way to check it.
  const junk = await call(VAN, '/auth/login', {
    method: 'POST',
    key: 'vf_0000000000000000000000000000000000000000',
    body: { userNumber: ADMIN, password: PASS },
  });
  if (junk.ok) ok('a stray licence key is ignored rather than refused');
  else bad('a stray key locked the customer out', JSON.stringify(junk.body).slice(0, 300));

  step('2 · Every feature is on');

  // Feature gating asks the licence what the company bought. With no licence
  // there is nothing to ask, and the answer has to be "everything" — these
  // customers paid for the software outright.
  const gated = [
    ['/erp/sync/status', 'erp_sync'],
    ['/reports/sales-summary?from=2026-01-01&to=2026-12-31', 'reports'],
    ['/collections?limit=1', 'collections'],
    ['/customers?limit=1', 'vansales'],
  ];
  for (const [path, feature] of gated) {
    const res = await call(VAN, path, { token: s.van });
    // 404 means the route moved — worth knowing, but it is not a licence
    // refusal. 402/403 with a licence code is the failure this test exists for.
    const refused =
      res.status === 402 ||
      (res.status === 403 && JSON.stringify(res.body).includes('licen'));
    if (refused) bad(`${feature} was refused on an unlicensed install`, JSON.stringify(res.body).slice(0, 200));
    else ok(`${feature} is available`, String(res.status));
  }

  step('3 · The control plane cannot reach in');

  const provision = await call(VAN, '/internal/tenants', {
    method: 'POST',
    secret: 'anything',
    body: { crmTenantId: '00000000-0000-0000-0000-000000000001', code: 'X', name: 'X' },
  });
  if (provision.status === 503) ok('provisioning is switched off, not merely unguarded', '503');
  else bad('provisioning endpoint is reachable on a customer server', `got ${provision.status}`);

  const keys = await call(VAN, '/internal/service-keys', {
    method: 'POST',
    secret: 'anything',
    body: { crmTenantId: '00000000-0000-0000-0000-000000000001', kind: 'maps', value: 'x' },
  });
  if (keys.status === 503) ok('nobody can push a service key into this machine', '503');
  else bad('the service-key endpoint is open here', `got ${keys.status}`);

  const pw = await call(VAN, '/internal/admin-password', {
    method: 'POST',
    secret: 'anything',
    body: { crmTenantId: '00000000-0000-0000-0000-000000000001', email: ADMIN, password: 'x' },
  });
  if (pw.status === 503) ok('nobody can reset their admin password from outside', '503');
  else bad('the admin-password endpoint is open here', `got ${pw.status}`);

  step('4 · The ERP, with no CRM either');

  const erpLicense = await call(ERP, '/api/v1/auth/license');
  if (erpLicense.data?.licensingEnabled === false) {
    ok('the ERP reports licensing is off');
  } else {
    bad('the ERP should report licensing off', JSON.stringify(erpLicense.data).slice(0, 200));
  }

  const loginPage = await call(ERP, '/login');
  if (loginPage.status === 200 && !/Licence key/i.test(loginPage.text)) {
    ok('the ERP login shows no licence key field', 'nothing to type');
  } else if (loginPage.status !== 200) {
    bad('the ERP login page did not load', `status ${loginPage.status}`);
  } else {
    bad('the ERP is asking a customer for a key they do not have');
  }

  const erpKeys = await call(ERP, '/api/v1/internal/service-keys', {
    method: 'POST',
    secret: 'anything',
    body: { crmTenantId: '00000000-0000-0000-0000-000000000001', kind: 'ai', value: 'x' },
  });
  if (erpKeys.status === 401) ok('the ERP refuses service-to-service calls here', '401');
  else bad('the ERP internal endpoint is open', `got ${erpKeys.status}`);

  step('5 · The settings screen still connects the two by hand');

  const before = await call(VAN, '/settings', { token: s.van });
  if (before.ok) ok('the settings screen loads');
  else bad('settings', JSON.stringify(before.body).slice(0, 200));

  const set = await call(VAN, '/settings/erp', {
    method: 'PATCH',
    token: s.van,
    body: {
      enabled: true,
      baseUrl: 'http://erp:3000',
      apiKey: 'onprem-typed-by-hand-0000',
    },
  });
  if (set.ok) ok('an address and key typed in by hand are accepted');
  else bad('the manual ERP connection was refused', JSON.stringify(set.body).slice(0, 300));

  const after = await call(VAN, '/settings', { token: s.van });
  const cfg = after.data?.erp ?? {};
  if (cfg.enabled && cfg.baseUrl === 'http://erp:3000' && cfg.apiKeyLast4 === '0000') {
    ok('and they stuck', `${cfg.baseUrl} ····${cfg.apiKeyLast4}`);
  } else {
    bad('the typed connection did not persist', JSON.stringify(cfg));
  }

  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  if (failures.length) console.log('\nFailures:\n' + failures.map((f) => `  · ${f}`).join('\n'));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\x1b[31mharness crashed:\x1b[0m', e); process.exit(2); });
