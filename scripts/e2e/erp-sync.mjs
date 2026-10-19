/**
 * The VanFlow ↔ ERP sync, with real data on both sides.
 *
 * Ordering matters and is the whole trick: the ERP is provisioned first and
 * seeded through a link key of its own, and VanFlow is provisioned afterwards —
 * because pairing ROTATES the link key, so anything minted before it is retired
 * the moment VanFlow arrives. Seeding after would leave the harness holding a
 * dead key and looking like a sync failure.
 */

import { execFileSync } from 'node:child_process';

const CRM = 'http://localhost:3200/api/v1';
const VAN = 'http://localhost:3100/api/v1';
const ERP = 'http://localhost:3500/api/v1';
const ERP_SECRET = process.env.ERP_INTERNAL_SECRET ?? 'local-suite-erp-secret';

const CODE = process.env.CODE ?? 'SYNCZ';
const ADMIN_EMAIL = `boss@${CODE.toLowerCase()}.local`;
const ADMIN_PASS = 'syncpass12345';

let pass = 0, fail = 0;
const failures = [];
const ok = (n, x = '') => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${x ? ` \x1b[90m${x}\x1b[0m` : ''}`); };
const bad = (n, d) => { fail++; failures.push(n); console.log(`  \x1b[31m✗\x1b[0m ${n}`); if (d) console.log(`    \x1b[31m${String(d).slice(0, 400)}\x1b[0m`); };
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read the ERP's own database.
 *
 * The link key is rotated by pairing, so a harness that minted one before
 * VanFlow arrived is holding a dead key by the time it wants to check the
 * result. Asking the database is also the stronger assertion: it proves the row
 * exists rather than that an endpoint said so.
 */
function sql(query) {
  return execFileSync(
    'docker',
    ['exec', 'vanflow-suite-erp-db-1', 'psql', '-U', 'postgres', '-d', 'erp_database', '-tAc', query],
    { encoding: 'utf8' },
  ).trim();
}

async function call(base, path, o = {}) {
  const res = await fetch(`${base}${path}`, {
    method: o.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.key ? { 'x-license-key': o.key } : {}),
      ...(o.secret ? { 'x-internal-secret': o.secret } : {}),
      ...(o.idem ? { 'idempotency-key': o.idem } : {}),
    },
    ...(o.body ? { body: JSON.stringify(o.body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, ok: res.ok, body: parsed, data: parsed.data ?? parsed };
}

const s = {};

async function main() {
  step('1 · A company with the ERP only');

  const login = await call(CRM, '/auth/login', {
    method: 'POST',
    body: { email: 'admin@7software.local', password: 'platform1234' },
  });
  if (!login.ok) return bad('sign in to the CRM', JSON.stringify(login.body));
  s.crm = login.data.accessToken;
  ok('sign in to the CRM');

  const found = await call(CRM, `/tenants?limit=100&q=${CODE}`, { token: s.crm });
  for (const t of found.data?.items ?? []) {
    if (t.code === CODE) await call(CRM, `/tenants/${t.id}`, { method: 'DELETE', token: s.crm });
  }

  const made = await call(CRM, '/tenants', {
    method: 'POST', token: s.crm,
    body: { code: CODE, name: 'Sync Data Co', adminEmail: ADMIN_EMAIL, adminName: 'Sync Boss', adminPassword: ADMIN_PASS },
  });
  if (!made.ok) return bad('create the company', JSON.stringify(made.body));
  s.tenantId = made.data.tenant.id;
  s.adminId = made.data.admin.id;
  await call(CRM, `/licenses/tenant/${s.tenantId}`, { method: 'POST', token: s.crm, body: {} });
  const keyRow = await call(CRM, `/licenses/tenant/${s.tenantId}`, { token: s.crm });
  const rev = await call(CRM, `/licenses/${keyRow.data[0].id}/reveal`, { token: s.crm });
  s.key = rev.data.key;
  ok('create the company and issue its key', CODE);

  const pe = await call(CRM, `/tenants/${s.tenantId}/apps/erp`, {
    method: 'POST', token: s.crm,
    body: { adminUserId: s.adminId, adminPassword: ADMIN_PASS },
  });
  if (!pe.ok) return bad('provision the ERP', JSON.stringify(pe.body));
  s.orgId = pe.data.externalId;
  ok('provision the ERP', s.orgId);

  const seeded = sql(
    `select (select count(*) from tax_rates where org_id = '${s.orgId}')
         || '/' || (select count(*) from warehouses where org_id = '${s.orgId}')`,
  );
  const [taxCount, whCount] = seeded.split('/').map(Number);
  if (taxCount > 0) ok('provisioning left the company able to price things', `${taxCount} tax rates`);
  else bad('a provisioned company has no tax rate — it cannot create a single product');
  if (whCount > 0) ok('provisioning left the company somewhere to keep stock', `${whCount} warehouse`);
  else bad('a provisioned company has no warehouse');

  // ── 2. seed the ERP ─────────────────────────────────────────────────────
  step('2 · Put real data in the ERP');

  const mint = await call(ERP, '/internal/tenants', {
    method: 'POST', secret: ERP_SECRET,
    body: { crmTenantId: s.tenantId, code: CODE, name: 'Sync Data Co', rotateLinkKey: true },
  });
  s.erpKey = mint.data?.apiKey;
  if (!s.erpKey) return bad('mint a seeding key for the ERP', JSON.stringify(mint.body));
  ok('mint a seeding key');

  const scopeCheck = await call(ERP, '/organization', {
    method: 'PATCH', token: s.erpKey,
    body: { name: 'Sync Data Co' },
  });
  if (scopeCheck.ok) ok('the link key may write the organisation', 'organization:write');
  else bad('the link key cannot write the organisation — VanFlow pushes company details', `${scopeCheck.status} ${JSON.stringify(scopeCheck.body).slice(0, 200)}`);

  const cat = await call(ERP, '/categories', {
    method: 'POST', token: s.erpKey,
    body: { name: 'Beverages' },
  });
  if (cat.ok) ok('create a category', 'Beverages');
  else bad('create a category', JSON.stringify(cat.body).slice(0, 300));

  const taxes = await call(ERP, '/tax-rates', { token: s.erpKey });
  const taxRateId = (taxes.data?.items ?? taxes.data ?? [])[0]?.id;
  if (taxRateId) ok('the org has a tax rate to price against');
  else bad('no tax rate in the seeded org', JSON.stringify(taxes.body).slice(0, 300));

  const prod = await call(ERP, '/products', {
    method: 'POST', token: s.erpKey,
    body: {
      name: 'Cola 330ml',
      categoryId: cat.data?.id,
      taxRateId,
      unitCost: 0.3,
      sellingPrice: 0.5,
      baseUnit: {
        name: 'Piece',
        sku: 'COLA330',
        barcode: '6291000000017',
        unitCost: 0.3,
        sellingPrice: 0.5,
        initialStock: 500,
      },
    },
  });
  if (prod.ok) ok('create a product with a SKU', 'COLA330');
  else bad('create a product', JSON.stringify(prod.body).slice(0, 400));

  // ── a van asking for stock ──────────────────────────────────────────────
  // Tested here rather than after pairing, because pairing rotates the link key
  // and this endpoint belongs to the ERP alone.
  const vanWh = await call(ERP, '/warehouses', {
    method: 'POST', token: s.erpKey,
    body: { name: 'Van 01', code: 'VAN-01', isVan: true },
  });
  if (vanWh.ok) ok('create a van warehouse', 'VAN-01');
  else bad('create a van warehouse', JSON.stringify(vanWh.body).slice(0, 300));

  const vsr = await call(ERP, '/van-stock-requests', {
    method: 'POST', token: s.erpKey, idem: 'REQ-E2E-1',
    body: {
      externalId: 'e2e-request-1',
      requestNumber: 'REQ-E2E-1',
      vanWarehouseCode: 'VAN-01',
      sourceWarehouseCode: 'MAIN',
      repCode: 'R1',
      repName: 'Test Rep',
      requestedAt: '2026-08-26T09:00:00.000Z',
      lines: [{ skuCode: 'COLA330', label: 'Cola 330ml', requestedQty: 20, approvedQty: 10 }],
    },
  });
  if (vsr.ok) {
    ok('a van stock request is accepted', 'was a 404 on every retry before');
    const moved = sql(
      `select count(*) from stock_transfers where org_id = '${s.orgId}'`,
    );
    if (Number(moved) > 0) ok('it became a stock transfer in the ERP', `${moved}`);
    else bad('the request was accepted but no transfer exists');
  } else {
    bad('a van stock request', `${vsr.status} ${JSON.stringify(vsr.body).slice(0, 400)}`);
  }

  const noSource = await call(ERP, '/van-stock-requests', {
    method: 'POST', token: s.erpKey, idem: 'REQ-E2E-2',
    body: {
      externalId: 'e2e-request-2',
      requestNumber: 'REQ-E2E-2',
      vanWarehouseCode: 'VAN-01',
      lines: [{ skuCode: 'COLA330', approvedQty: 5 }],
    },
  });
  if (noSource.ok) ok('an unstated source falls back to the one real warehouse');
  else bad('unstated source', `${noSource.status} ${JSON.stringify(noSource.body).slice(0, 300)}`);

  const noneApproved = await call(ERP, '/van-stock-requests', {
    method: 'POST', token: s.erpKey, idem: 'REQ-E2E-3',
    body: {
      externalId: 'e2e-request-3',
      requestNumber: 'REQ-E2E-3',
      vanWarehouseCode: 'VAN-01',
      sourceWarehouseCode: 'MAIN',
      lines: [{ skuCode: 'COLA330', requestedQty: 5, approvedQty: 0 }],
    },
  });
  if (noneApproved.status === 400) ok('a request with nothing approved is refused, not half-applied');
  else bad('nothing-approved request', `got ${noneApproved.status}`);

  const cust = await call(ERP, '/customers', {
    method: 'POST', token: s.erpKey,
    body: { name: 'Corner Shop', code: 'CUST-001' },
  });
  if (cust.ok) ok('create a customer', 'CUST-001');
  else bad('create a customer', JSON.stringify(cust.body).slice(0, 300));

  // ── 3. now VanFlow ──────────────────────────────────────────────────────
  step('3 · Provision VanFlow — pairing rotates the key');

  const pv = await call(CRM, `/tenants/${s.tenantId}/apps/cashvan`, {
    method: 'POST', token: s.crm,
    body: { adminUserId: s.adminId, adminPassword: ADMIN_PASS },
  });
  if (!pv.ok) return bad('provision VanFlow', JSON.stringify(pv.body));
  ok('provision VanFlow', pv.data.externalId);

  const vl = await call(VAN, '/auth/login', {
    method: 'POST', key: s.key,
    body: { userNumber: ADMIN_EMAIL, password: ADMIN_PASS },
  });
  if (!vl.ok) return bad('sign in to VanFlow', JSON.stringify(vl.body));
  s.van = vl.data.accessToken;
  ok('sign in to VanFlow');

  const cfg = await call(VAN, '/settings', { token: s.van, key: s.key });
  if (cfg.data?.erp?.enabled && cfg.data.erp.baseUrl && cfg.data.erp.apiKeyLast4) {
    ok('paired automatically', `${cfg.data.erp.baseUrl} ····${cfg.data.erp.apiKeyLast4}`);
  } else {
    bad('pairing', JSON.stringify(cfg.data?.erp));
  }

  const test = await call(VAN, '/settings/erp/test', { method: 'POST', token: s.van, key: s.key });
  if (test.data?.ok) ok('VanFlow can reach the ERP');
  else bad('VanFlow cannot reach the ERP', JSON.stringify(test.body).slice(0, 300));

  // ── 4. pull ─────────────────────────────────────────────────────────────
  step('4 · Pull the ERP catalogue into VanFlow');

  const refresh = await call(VAN, '/erp/sync/refresh', { method: 'POST', token: s.van, key: s.key });
  const rows = Array.isArray(refresh.data) ? refresh.data : [];
  if (!rows.length) bad('refresh returned nothing', JSON.stringify(refresh.body).slice(0, 400));

  const want = { organization: 1, warehouse: 1, category: 1, item: 1, customer: 1 };
  for (const r of rows) {
    const label = `pull ${r.entity}`;
    if (r.status !== 'ok') { bad(label, r.error); continue; }
    const need = want[r.entity];
    if (need !== undefined && (r.count ?? 0) < need) {
      bad(`${label} — nothing came across`, `expected at least ${need}, got ${r.count}`);
    } else {
      ok(label, String(r.count ?? 0));
    }
  }

  const items = await call(VAN, '/products?limit=5', { token: s.van, key: s.key });
  const gotItem = (items.data?.items ?? items.data ?? []).some?.((p) => p.itemNumber === 'COLA330' || p.nameEn === 'Cola 330ml');
  if (gotItem) ok('the ERP item is in VanFlow');
  else bad('the ERP item never arrived in VanFlow', JSON.stringify(items.data).slice(0, 300));

  const customers = await call(VAN, '/customers?limit=5', { token: s.van, key: s.key });
  const gotCust = (customers.data?.items ?? customers.data ?? []).some?.((c) => c.code === 'CUST-001' || c.nameAr === 'Corner Shop');
  if (gotCust) ok('the ERP customer is in VanFlow');
  else bad('the ERP customer never arrived in VanFlow', JSON.stringify(customers.data).slice(0, 300));

  // ── 5. push ─────────────────────────────────────────────────────────────
  step('5 · Push from VanFlow back to the ERP');

  const newCust = await call(VAN, '/customers', {
    method: 'POST', token: s.van, key: s.key,
    body: { customerName: 'زبون من الفان', paymentTerms: 0 },
  });
  if (!newCust.ok) {
    bad('create a customer in VanFlow', JSON.stringify(newCust.body).slice(0, 300));
  } else {
    const code = newCust.data.customerNumber;
    ok('create a customer in VanFlow', code);

    // The push is synchronous on the create, so a successful one never touches
    // the outbox. Ask the ERP whether the row is there rather than inferring it
    // from a queue that is empty in both the good and the bad case.
    let landed = '';
    for (let i = 0; i < 10 && !landed; i++) {
      await sleep(1500);
      landed = sql(
        `select code from customers where org_id = '${s.orgId}' and code = '${code}' limit 1`,
      );
    }
    if (landed) ok('the new customer reached the ERP', landed);
    else {
      const box = await call(VAN, '/erp/outbox?limit=50', { token: s.van, key: s.key });
      bad('the customer never reached the ERP', JSON.stringify(box.data).slice(0, 400));
    }
  }

  // ── 6. suspension ───────────────────────────────────────────────────────
  step('6 · What suspension does to a working company');

  const keyRows = await call(CRM, `/licenses/tenant/${s.tenantId}`, { token: s.crm });
  const licId = keyRows.data.find((k) => k.status !== 'revoked')?.id;
  await call(CRM, `/licenses/${licId}/status`, {
    method: 'PATCH', token: s.crm, body: { status: 'suspended' },
  });
  // The products cache the answer for a minute on purpose; ask the CRM itself.
  const susp = await call(CRM, '/licenses/validate', {
    method: 'POST', body: { key: s.key, app: 'cashvan' },
  });
  if (susp.data.valid === true && susp.data.writesAllowed === false) {
    ok('a suspended company keeps its login and its reads, and loses the write');
  } else {
    bad('suspension', JSON.stringify(susp.data).slice(0, 200));
  }
  await call(CRM, `/licenses/${licId}/status`, {
    method: 'PATCH', token: s.crm, body: { status: 'active' },
  });
  const back = await call(CRM, '/licenses/validate', {
    method: 'POST', body: { key: s.key, app: 'cashvan' },
  });
  if (back.data.writesAllowed) ok('reactivating gives the write back');
  else bad('reactivation', JSON.stringify(back.data).slice(0, 200));

  const box = await call(VAN, '/erp/outbox?limit=100', { token: s.van, key: s.key });
  const all = box.data?.items ?? box.data ?? [];
  const dead = all.filter?.((r) => r.status === 'dead_letter') ?? [];
  if (dead.length === 0) ok('nothing in the outbox is dead-lettered');
  else bad(`${dead.length} outbox rows dead-lettered`, dead.map((d) => `${d.kind} ${d.ref}: ${d.error}`).join(' | '));

  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  if (failures.length) console.log('\nFailures:\n' + failures.map((f) => `  · ${f}`).join('\n'));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\x1b[31mharness crashed:\x1b[0m', e); process.exit(2); });
