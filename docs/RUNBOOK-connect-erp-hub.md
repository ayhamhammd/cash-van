# Runbook — Connect the ERP to FlowVan via the Integration Hub

> A step-by-step guide for a human operator to connect an **ERP company** to a
> **FlowVan (cash-van) company** through the **Integration Hub**. Contract details:
> [SPEC-integration-hub.md](SPEC-integration-hub.md). Automated smoke check:
> `node scripts/check-hub-integration.mjs`.

## Who does what

| Role | Owns |
|---|---|
| **Hub admin** | the Integration Hub (`ADMIN_API_TOKEN`), partners + credentials |
| **ERP admin** | the ERP, its API keys, warehouses, the Van Sales key |
| **FlowVan admin** | the cash-van dashboard → Settings → Integration Hub |

## Before you start (prerequisites)

- [ ] The **Hub** is deployed and healthy: `GET {HUB}/api/health` → `{ "status": "ok" }`.
- [ ] The **FlowVan** backend is deployed and **reachable from the Hub** over HTTPS.
- [ ] The **ERP** has API access and can issue a Van Sales API key.
- [ ] You can sign into the FlowVan dashboard as **admin**.

You will end up moving **four values** into FlowVan:

| Value | Comes from |
|---|---|
| Hub base URL | ops (where the Hub is hosted) |
| `partnerId` (UUID) | Step 1 (provisioning) |
| **Sync secret** | Step 2 (the VAN_SALES bearer secret) |
| **Webhook secret** | Step 2 (the endpoint signing secret) |

---

## Step 1 — Provision the partner (ERP ↔ Van company)

Creates one partner row in the Hub linking the ERP org to the FlowVan company.

**Option A — automatic (ERP-driven).** In the ERP, create a **Van Sales API key**.
The ERP calls `POST {HUB}/api/provisioning/erp/van-sales` and the Hub returns:
```jsonc
{ "data": {
  "partnerId": "…",                                     // ← keep this
  "vanSalesWebhookReceiverUrl": "{HUB}/api/webhooks/van-sales/{partnerId}",
  "erpWebhookReceiverUrl":      "{HUB}/api/webhooks/erp/{partnerId}",
  "erpWebhookSecret": "whsec_…" } }                     // ERP stores this
```

**Option B — manual (Hub admin).**
```bash
curl -X POST {HUB}/api/integrations/partners \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{ "name":"Acme ↔ Van Fleet", "erpOrganizationName":"Acme", "vanSalesCompanyName":"Van Fleet" }'
# → { "id": "<partnerId>" }
```
Then attach the ERP credential (so the Hub can reach the ERP):
```bash
curl -X POST {HUB}/api/integrations/partners/<partnerId>/credentials \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{ "systemName":"ERP", "apiBaseUrl":"https://erp.example.com", "apiKey":"erp_…", "webhookSecret":"whsec_erp" }'
```

➡️ **Write down the `partnerId`.**

---

## Step 2 — Register FlowVan (the VAN_SALES side) in the Hub

Tell the Hub how to authenticate FlowVan and where to deliver events. Pick two
secrets now (any strong random strings, e.g. `whsec_` + 24 random bytes):
`SYNC_SECRET` and `WEBHOOK_SECRET`.

```bash
curl -X POST {HUB}/api/integrations/partners/<partnerId>/credentials \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "systemName":  "VAN_SALES",
    "apiBaseUrl":  "https://<flowvan-backend>",
    "webhookSecret": "'"$SYNC_SECRET"'",             // FlowVan presents this on /api/sync/*
    "webhookUrl":  "https://<flowvan-backend>/api/v1/webhooks/hub"
  }'
```

- `SYNC_SECRET` → FlowVan's **Sync secret** (the `Authorization: Bearer` on outbound sync).
- The **Hub → FlowVan** webhooks are signed with each endpoint's own secret; set
  `WEBHOOK_SECRET` on the ERP→VAN_SALES `webhook_endpoints` rows (Hub admin UI /
  API), and use the **same** value as FlowVan's **Webhook secret** so signatures verify.
  *(This is decision D3 in the spec — confirm the exact route for setting the endpoint
  secret with your Hub build.)*

---

## Step 3 — Confirm the webhook route points at FlowVan

The Hub should have `webhook_endpoints` (source `ERP` → target `VAN_SALES`) for
the events `sales_invoice.created`, `payment.created`, `sales_return.created`,
`stock_transfer.created`, `inventory.stock_changed`, all pointing at:
```
https://<flowvan-backend>/api/v1/webhooks/hub
```
(Provisioning in Step 1 creates these when `vanSalesWebhookUrl` is supplied.)

---

## Step 4 — Map warehouses / vans (Hub)

For each van, add a Hub `warehouse_mappings` row linking the **ERP warehouse code**
to the **FlowVan van/salesman code**, so the Hub can translate `warehouseCode` on
each document. Confirm one mapping per active van.

---

## Step 5 — Configure FlowVan (dashboard)

FlowVan dashboard → **Settings → Integration Hub**:

1. **Hub base URL** = `{HUB}` (e.g. `https://hub.example.com`).
2. **Partner ID** = the `partnerId` from Step 1.
3. **Sync secret** = `SYNC_SECRET` from Step 2.
4. **Webhook verify secret** = `WEBHOOK_SECRET` from Step 2.
5. Click **Test connection** → expect “Connected to the Integration Hub successfully”.
6. **Save.**

> Keep **Settings → ERP** connected too (ERP read access). The Hub routes documents
> and pushes event *notifications*, but FlowVan reconciles stock by pulling the ERP
> movement ledger directly (the ERP is stock master).

---

## Step 6 — Turn it on

On the same tab, enable **“Push via the Integration Hub”** and Save. From now on,
posted sales / returns / collections / transfers push **through the Hub** instead
of directly to the ERP. (Only one path is active — no double-posting.)

---

## Step 7 — Verify end-to-end

1. **Outbound:** make a test **sale** in the mobile app (or dashboard). Within a
   few seconds the **ERP** should show an invoice whose number equals the FlowVan
   voucher number. Re-posting the same voucher must **not** create a second ERP
   invoice (idempotent).
2. **Inbound stock:** change stock in the **ERP** for a mapped warehouse. FlowVan’s
   **Settings → Integration Hub → Inbound events** should log an
   `inventory.stock_changed` (status `processed`), and the item’s stock should
   update on the dashboard + app within seconds.
3. **Automated check** (FlowVan side, no live Hub needed):
   ```bash
   node scripts/check-hub-integration.mjs
   ```
   Expect **ALL PASSED** (login, signed webhook accepted, dedup, bad-signature 401,
   stale-timestamp 401, ops-log visible). *Note: this sets a **test** webhook secret —
   re-enter your real one (Step 5.4) afterward.*

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Test connection fails | wrong/unreachable Hub base URL | check `{HUB}/api/health`, HTTPS, firewall |
| Outbound docs stuck `failed`/`dead_letter` (ERP Export monitor) | `partner_inactive` / `erp_not_configured` / bad `SYNC_SECRET` | partner must be `ACTIVE` in the Hub; ERP credential set on the partner; Sync secret matches Step 2 |
| Inbound webhook returns `401 invalid_signature` | FlowVan **Webhook secret** ≠ the endpoint signing secret | make Step 5.4 == the `WEBHOOK_SECRET` used in Step 2 |
| Inbound events never arrive | webhook endpoint URL wrong / not `ACTIVE` | verify `webhook_endpoints` → `https://<flowvan>/api/v1/webhooks/hub` |
| `inventory.stock_changed` logged but stock doesn’t change | ERP read access off, or warehouse not mapped | keep Settings → ERP connected; add the Hub `warehouse_mappings` row |
| Prices off by 1000× | money unit mismatch | FlowVan sends **JOD major** (`1.500`); confirmed against the ERP write API (D4) |
| Tobacco tax missing on Hub-routed sales | Hub strips tobacco line fields (D8) | keep tobacco vans on the direct path, or extend the Hub sync schema |

## Rollback

Set **“Push via the Integration Hub” = off** (Settings → Integration Hub). FlowVan
immediately reverts to the direct ERP path. No data migration needed.
