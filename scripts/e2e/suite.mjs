/**
 * End to end across the whole suite: create a company in the CRM, put it into
 * both products, then make VanFlow and the ERP actually talk to each other.
 *
 * Written as a script rather than a test suite because it is the only thing
 * that can prove the sync: every part of it crosses a network to another
 * service with its own database, and mocking either side would test the mock.
 */

const CRM = 'http://localhost:3200/api/v1';
const VAN = 'http://localhost:3100/api/v1';
const ERP = 'http://localhost:3500/api/v1';

const CODE = process.env.CODE ?? 'SYNCX';
const ADMIN_EMAIL = `boss@${CODE.toLowerCase()}.local`;
const ADMIN_PASS = 'syncpass12345';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, extra = '') {
  pass++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? ` \x1b[90m${extra}\x1b[0m` : ''}`);
}
function bad(name, detail) {
  fail++;
  failures.push({ name, detail });
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`    \x1b[31m${String(detail).slice(0, 500)}\x1b[0m`);
}
function step(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function call(base, path, { method = 'GET', body, token, key, secret } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'x-license-key': key } : {}),
      ...(secret ? { 'x-internal-secret': secret } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, ok: res.ok, body: parsed, data: parsed.data ?? parsed };
}

const state = {};

async function main() {
  // ── 1. the control plane ────────────────────────────────────────────────
  step('1 · 7CRM');

  const login = await call(CRM, '/auth/login', {
    method: 'POST',
    body: { email: 'admin@7software.local', password: 'platform1234' },
  });
  if (!login.ok) return bad('sign in to the CRM', JSON.stringify(login.body));
  state.crmToken = login.data.accessToken;
  ok('sign in to the CRM');

  const cat = await call(CRM, '/apps', { token: state.crmToken });
  if (cat.ok && Array.isArray(cat.data) && cat.data.length >= 4) {
    ok('the product catalogue lists every application', cat.data.map((a) => a.name).join(', '));
  } else {
    bad('the product catalogue', JSON.stringify(cat.body));
  }

  // Start clean: a leftover from a previous run holds the code.
  const existing = await call(CRM, `/tenants?limit=100&q=${CODE}`, { token: state.crmToken });
  for (const t of existing.data?.items ?? []) {
    if (t.code === CODE) {
      await call(CRM, `/tenants/${t.id}`, { method: 'DELETE', token: state.crmToken });
    }
  }

  const created = await call(CRM, '/tenants', {
    method: 'POST',
    token: state.crmToken,
    body: {
      code: CODE,
      name: 'Sync Test Co',
      adminEmail: ADMIN_EMAIL,
      adminName: 'Sync Boss',
      adminPassword: ADMIN_PASS,
    },
  });
  if (!created.ok) return bad('create the company', JSON.stringify(created.body));
  state.tenantId = created.data.tenant.id;
  state.adminId = created.data.admin.id;
  ok('create the company', CODE);

  const issued = await call(CRM, `/licenses/tenant/${state.tenantId}`, {
    method: 'POST',
    token: state.crmToken,
    body: { label: 'e2e' },
  });
  if (!issued.ok) return bad('issue the company key', JSON.stringify(issued.body));
  state.key = issued.data.key;
  ok('issue ONE key for the company', `${state.key.slice(0, 12)}…`);

  const second = await call(CRM, `/licenses/tenant/${state.tenantId}`, {
    method: 'POST',
    token: state.crmToken,
    body: {},
  });
  if (second.status === 409) ok('a second key is refused — one key per company');
  else bad('a second key should be refused', `got ${second.status}`);

  // ── 2. provisioning ─────────────────────────────────────────────────────
  step('2 · Provisioning');

  const pv = await call(CRM, `/tenants/${state.tenantId}/apps/cashvan`, {
    method: 'POST',
    token: state.crmToken,
    body: { adminUserId: state.adminId, adminPassword: ADMIN_PASS },
  });
  if (pv.ok) ok('provision VanFlow', pv.data.externalId);
  else bad('provision VanFlow', JSON.stringify(pv.body));

  const pe = await call(CRM, `/tenants/${state.tenantId}/apps/erp`, {
    method: 'POST',
    token: state.crmToken,
    body: { adminUserId: state.adminId, adminPassword: ADMIN_PASS },
  });
  if (pe.ok) ok('provision the ERP', pe.data.externalId);
  else bad('provision the ERP', JSON.stringify(pe.body));

  const keysAfter = await call(CRM, `/licenses/tenant/${state.tenantId}`, {
    token: state.crmToken,
  });
  const live = (keysAfter.data ?? []).filter((k) => k.status !== 'revoked');
  if (live.length === 1) ok('still exactly one key after provisioning both');
  else bad('provisioning minted extra keys', `${live.length} live keys`);

  const apps = await call(CRM, `/tenants/${state.tenantId}/applications`, {
    token: state.crmToken,
  });
  state.apps = apps.data ?? [];
  const van = state.apps.find((a) => a.key === 'cashvan');
  const erp = state.apps.find((a) => a.key === 'erp');
  if (van?.provisioned && erp?.provisioned) {
    ok('both applications report provisioned', `VanFlow ${van.featureCount.on}/${van.featureCount.total}, ERP ${erp.featureCount.on}/${erp.featureCount.total}`);
  } else {
    bad('applications state', JSON.stringify(apps.body).slice(0, 300));
  }
  if (van?.features?.includes('erp_sync')) ok('erp_sync is on by default in VanFlow');
  else bad('erp_sync should default on', JSON.stringify(van?.features));

  // ── 3. what the key says ────────────────────────────────────────────────
  step('3 · What the key says');

  const v1 = await call(CRM, '/licenses/validate', {
    method: 'POST',
    body: { key: state.key, app: 'cashvan' },
  });
  if (v1.data.valid && v1.data.writesAllowed && v1.data.apps?.length === 2) {
    ok('one key resolves to the company and both applications');
  } else {
    bad('validate', JSON.stringify(v1.body).slice(0, 300));
  }

  await call(CRM, `/tenants/${state.tenantId}/applications/erp/enabled`, {
    method: 'PATCH',
    token: state.crmToken,
    body: { enabled: false },
  });
  const vErpOff = await call(CRM, '/licenses/validate', {
    method: 'POST',
    body: { key: state.key, app: 'erp' },
  });
  const vVanStill = await call(CRM, '/licenses/validate', {
    method: 'POST',
    body: { key: state.key, app: 'cashvan' },
  });
  if (!vErpOff.data.valid && vErpOff.data.reason === 'app_disabled' && vVanStill.data.valid) {
    ok('revoking the ERP stops the ERP and leaves VanFlow working');
  } else {
    bad('per-application revoke', `erp=${vErpOff.data.reason} van=${vVanStill.data.valid}`);
  }
  await call(CRM, `/tenants/${state.tenantId}/applications/erp/enabled`, {
    method: 'PATCH',
    token: state.crmToken,
    body: { enabled: true },
  });

  // ── 4. the pairing ──────────────────────────────────────────────────────
  step('4 · VanFlow ↔ ERP pairing');

  const vanLogin = await call(VAN, '/auth/login', {
    method: 'POST',
    key: state.key,
    body: { userNumber: ADMIN_EMAIL, password: ADMIN_PASS },
  });
  if (!vanLogin.ok) return bad('sign in to VanFlow', JSON.stringify(vanLogin.body));
  state.vanToken = vanLogin.data.accessToken;
  ok('sign in to VanFlow with the company key');

  const settings = await call(VAN, '/settings', { token: state.vanToken, key: state.key });
  const erpCfg = settings.data?.erp ?? {};
  state.erpBaseUrl = erpCfg.baseUrl;
  if (settings.ok && erpCfg.baseUrl && erpCfg.apiKeyLast4) {
    ok('the CRM filled in the ERP connection', `${erpCfg.baseUrl} ····${erpCfg.apiKeyLast4}`);
  } else {
    bad('ERP connection was not paired automatically', JSON.stringify(erpCfg));
  }
  if (erpCfg.enabled) ok('erp sync is switched on');
  else bad('erp sync is off after pairing');

  const ping = await call(VAN, '/settings/erp/test', {
    method: 'POST',
    token: state.vanToken,
    key: state.key,
  });
  if (ping.ok && ping.data?.ok !== false) ok('VanFlow can reach the ERP', JSON.stringify(ping.data).slice(0, 160));
  else bad('VanFlow cannot reach the ERP', JSON.stringify(ping.body).slice(0, 400));

  // ── 5. the sync itself ──────────────────────────────────────────────────
  step('5 · Pulling from the ERP');

  const refresh = await call(VAN, '/erp/sync/refresh', {
    method: 'POST',
    token: state.vanToken,
    key: state.key,
  });
  if (!refresh.ok) {
    bad('refresh from the ERP', JSON.stringify(refresh.body).slice(0, 600));
  } else {
    const rows = Array.isArray(refresh.data) ? refresh.data : [];
    for (const r of rows) {
      const label = `pull ${r.entity}`;
      if (r.status === 'ok' || r.ok === true) ok(label, `${r.count ?? 0}`);
      else bad(label, r.error ?? JSON.stringify(r));
    }
    if (rows.length === 0) bad('refresh returned no entities', JSON.stringify(refresh.body).slice(0, 300));
  }

  const status = await call(VAN, '/erp/sync/status', { token: state.vanToken, key: state.key });
  if (status.ok) ok('sync status readable', JSON.stringify(status.data).slice(0, 200));
  else bad('sync status', JSON.stringify(status.body).slice(0, 300));

  // ── 6. keys the CRM sets ────────────────────────────────────────────────
  step('6 · Service keys from the CRM');

  const setMaps = await call(CRM, `/tenants/${state.tenantId}/applications/cashvan/keys/maps`, {
    method: 'PUT',
    token: state.crmToken,
    body: { value: 'AIzaTESTKEYvalue0000000000000Kq7m', source: 'company' },
  });
  const mapsState = setMaps.data?.secrets?.find((s) => s.kind === 'maps');
  if (setMaps.ok && mapsState?.set && mapsState.last4 === 'Kq7m') {
    ok('set the Google Maps key into VanFlow', `····${mapsState.last4}`);
  } else {
    bad('set the maps key', JSON.stringify(setMaps.body).slice(0, 300));
  }

  const setAi = await call(CRM, `/tenants/${state.tenantId}/applications/erp/keys/ai`, {
    method: 'PUT',
    token: state.crmToken,
    body: { value: 'sk-ant-testvalue000000000000009f2c', source: 'company', meta: { provider: 'anthropic' } },
  });
  const aiState = setAi.data?.secrets?.find((s) => s.kind === 'ai');
  if (setAi.ok && aiState?.set) ok('set the AI key into the ERP', `····${aiState.last4}`);
  else bad('set the AI key', JSON.stringify(setAi.body).slice(0, 300));

  const badKind = await call(CRM, `/tenants/${state.tenantId}/applications/erp/keys/maps`, {
    method: 'PUT',
    token: state.crmToken,
    body: { value: 'x' },
  });
  if (badKind.status === 400) ok('the ERP refuses a maps key — it has no map');
  else bad('the ERP should refuse a maps key', `got ${badKind.status}`);

  // ── 7. the super admin ──────────────────────────────────────────────────
  step('7 · Super admin');

  const admin = await call(CRM, `/tenants/${state.tenantId}/admin`, { token: state.crmToken });
  if (admin.ok && admin.data?.email === ADMIN_EMAIL) ok('the company has one super admin', admin.data.email);
  else bad('super admin', JSON.stringify(admin.body).slice(0, 300));

  const reset = await call(CRM, `/tenants/${state.tenantId}/admin/reset-password`, {
    method: 'POST',
    token: state.crmToken,
  });
  if (!reset.ok) {
    bad('reset the super admin password', JSON.stringify(reset.body).slice(0, 300));
  } else {
    ok('reset the password', `pushed: ${JSON.stringify(reset.data.pushed)}`);
    const relog = await call(VAN, '/auth/login', {
      method: 'POST',
      key: state.key,
      body: { userNumber: ADMIN_EMAIL, password: reset.data.password },
    });
    if (relog.ok) ok('the new password works in VanFlow');
    else bad('the new password does not work in VanFlow', JSON.stringify(relog.body).slice(0, 300));

    const oldOne = await call(VAN, '/auth/login', {
      method: 'POST',
      key: state.key,
      body: { userNumber: ADMIN_EMAIL, password: ADMIN_PASS },
    });
    if (!oldOne.ok) ok('the old password stopped working');
    else bad('the old password still works after a reset');
    if (relog.ok) state.vanToken = relog.data.accessToken;
  }

  // ── 8. platform team ────────────────────────────────────────────────────
  step('8 · Platform team');

  const members = await call(CRM, '/platform/members', { token: state.crmToken });
  if (members.ok && members.data.length >= 1) ok('platform staff listed', `${members.data.length}`);
  else bad('platform members', JSON.stringify(members.body).slice(0, 300));

  const added = await call(CRM, '/platform/members', {
    method: 'POST',
    token: state.crmToken,
    body: {
      name: 'E2E Support',
      email: `e2e-support-${Date.now()}@7software.local`,
      password: 'supportpass12345',
      role: 'support',
    },
  });
  if (added.ok) {
    ok('add a support member');
    const removed = await call(CRM, `/platform/members/${added.data.id}`, {
      method: 'DELETE',
      token: state.crmToken,
    });
    if (removed.ok) ok('remove them again');
    else bad('remove a member', JSON.stringify(removed.body).slice(0, 200));
  } else {
    bad('add a platform member', JSON.stringify(added.body).slice(0, 300));
  }

  const me = await call(CRM, '/auth/me', { token: state.crmToken });
  const selfDemote = await call(CRM, `/platform/members/${me.data.id}`, {
    method: 'PATCH',
    token: state.crmToken,
    body: { role: 'readonly' },
  });
  if (selfDemote.status === 403) ok('you cannot take your own admin away');
  else bad('self-demotion should be refused', `got ${selfDemote.status}`);

  // ── report ──────────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  · ${f.name}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\x1b[31mharness crashed:\x1b[0m', e);
  process.exit(2);
});
