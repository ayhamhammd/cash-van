# SPEC — Connect FlowVan to the ERP via the Integration Hub

> Status: **DRAFT / plan** · Owner: backend · Target: `cash-van-dashboard` (NestJS) + dashboard UI
> Source of truth for the Hub contract: `ERP/integration-hub` (Next.js 15 middleware, port 3007).
> Machine-readable: `GET {HUB}/api/openapi.json`. Human docs: `{HUB}/docs`.

This spec describes how **FlowVan (the cash-van system = this repo + mobile app)** connects to the
**ERP** through the **Integration Hub** — an HTTP middleware that sits between the two systems. It
covers the wire contract we must implement, the onboarding steps, and a phased build plan for the
FlowVan side.

---

## 1. What the Integration Hub is (and is not)

The Hub is a thin, stateful **router + guarantee layer** between ERP and Van Sales. From
`integration-hub/README.md`:

- It stores **only** integration config, credentials, webhook routing, sync logs, retries, and
  document mappings — **never** ERP business data (customers, products, prices, stock, invoices,
  payments, returns, accounting).
- It talks to both systems **only over HTTP** (`/api/v1` + webhooks). It never touches either
  system's database.
- It is **never** the source of truth. The ERP still creates the real documents; the Hub just
  forwards, dedupes, retries, and logs.

**Value it adds for FlowVan** over our current *direct* `erp-sync` module:

| Concern | Direct `erp-sync` (today) | Via Integration Hub |
|---|---|---|
| Idempotency / dedup | We manage it in `erp_outbox` | Hub dedupes on `(partner, docType, externalId)` **and** sends `Idempotency-Key` |
| Retry + backoff | Our outbox worker | Hub retries `1m→5m→15m→1h→6h` (5 attempts) + standalone worker |
| ERP → Van events (stock, master data) | We poll / cursor-sync | Hub **pushes** signed webhooks to us |
| Coupling to ERP API shape | Tight | Hub absorbs some mapping; ERP endpoint can move behind it |
| Multi-tenant / per-partner | N/A | One partner row per ERP-org ↔ Van-company pair |

> **Decision needed (D1):** Hub is an **alternative** to the direct `erp-sync`, selected by a
> settings toggle (`erp.mode = "direct" | "hub"`). We do **not** run both push paths at once for the
> same document (double-post). See §8.

---

## 2. Topology

```
 ┌────────────────────┐   POST /api/sync/*  (Bearer VAN secret, Idempotency=externalId)
 │  FlowVan backend   │ ────────────────────────────────────────────►┐
 │ (cash-van-dashboard│                                               │
 │  NestJS)           │ ◄──────────────────────────────────────────┐ │
 └─────────┬──────────┘   POST {our}/webhooks/hub  (X-Hub-Signature)│ │
           │                                                        │ │
           │ (mobile app syncs vouchers/collections up to us first) │ │
           │                                                        │ ▼
           │                                        ┌───────────────┴─────────────┐
           │                                        │       Integration Hub       │
           │                                        │  partners · credentials ·   │
           │                                        │  webhook routing · sync_msgs│
           │                                        │  · doc mappings · retries   │
           │                                        └───────────────┬─────────────┘
           │                                            POST /api/v1/* (Bearer ERP key,
           │                                            Idempotency-Key: externalId)
           │                                                        │
           │                                                        ▼
           │                                        ┌──────────────────────────────┐
           │                                        │             ERP              │
           │                                        │  creates the real documents  │
           │                                        └──────────────────────────────┘
```

- **Van → ERP (documents):** FlowVan `POST`s to the Hub `/api/sync/*`; the Hub forwards to the ERP
  and returns the ERP document (id + number).
- **ERP → Van (events):** the ERP signs and posts events to the Hub; the Hub re-signs and forwards
  them to **our** webhook receiver (e.g. `inventory.stock_changed`, and status callbacks).

---

## 3. The wire contract FlowVan must implement

### 3.1 Authentication

| Direction | Mechanism |
|---|---|
| **Sync (Van → Hub)** | `Authorization: Bearer <VAN_SALES webhook secret>` (or `X-Partner-Token: <secret>`). The secret is the partner's stored `VAN_SALES` credential `webhookSecret`. |
| **Webhook (Hub → Van)** | HMAC. We verify `X-Hub-Signature: sha256=<hex>` where `hex = HMAC_SHA256(endpointSecret, "${X-Hub-Timestamp}.${rawBody}")`. |
| **Webhook (Van → Hub)** *(non-document events, optional)* | We sign `X-Van-Signature: sha256=<hex>` = `HMAC_SHA256(vanSecret, "${ts}.${rawBody}")` + `X-Van-Timestamp` + `X-Van-Event-Type`, POST to `/api/webhooks/van-sales/{partnerId}`. |

**Signature algorithm** (from `integration-hub/src/lib/crypto.ts`):
```
signature = HMAC_SHA256(secret, `${timestamp}.${rawBody}`)   // hex digest
header    = "sha256=" + signature
```
- `timestamp` = unix seconds (string), sent in `X-Hub-Timestamp` (inbound to us) / `X-Van-Timestamp`.
- `rawBody` = the exact raw request body bytes (verify **before** JSON parse; sign over the exact
  string we send).
- Compare in constant time. Reject if the timestamp is stale (recommend ±5 min skew window — the Hub
  itself does not currently enforce skew, but we should on our receiver).

### 3.2 Sync endpoints (Van → Hub → ERP)

All are `POST {HUB}/api/sync/<kind>`, `Content-Type: application/json`, `Authorization: Bearer <VAN secret>`.
Every body carries `partnerId` (uuid) and `externalId` (our idempotency key). Rate limit: **60 req/min
per partner** (`429` on breach, with `X-RateLimit-*` headers).

**`/api/sync/sales-invoices`**
```jsonc
{
  "partnerId": "<uuid>",
  "externalId": "VAN-INV-000123",        // REQUIRED, unique per docType, stable across retries
  "deviceId": "van-01",                   // optional
  "customerCode": "CUST-001",             // ERP customer business code (preferred)
  "customerId": "<uuid>",                 // optional alternative
  "warehouseCode": "VAN-001",             // Van code; Hub maps → ERP warehouse (see §6)
  "invoiceDate": "2026-07-04",            // optional ISO-ish string (max 40 chars)
  "currency": "JOD",                      // optional
  "paymentMethod": "CASH",                // CASH | CARD | BANK_TRANSFER | CHECK
  "notes": "…",
  "items": [
    { "skuCode": "SKU-1", "quantity": 3, "unitPrice": 1.500, "discount": 0, "taxRateId": null }
  ]
}
```
**`/api/sync/payments`**
```jsonc
{ "partnerId":"…","externalId":"VAN-PAY-000045","invoiceNumber":"INV-778","amount":12.500,
  "paymentMethod":"CASH","notes":"…" }
```
**`/api/sync/sales-returns`**
```jsonc
{ "partnerId":"…","externalId":"VAN-RET-0007","customerCode":"CUST-001","warehouseCode":"VAN-001",
  "originalInvoiceNumber":"INV-778","returnDate":"2026-07-04","reason":"…",
  "lines":[ { "skuCode":"SKU-1","quantity":1,"unitPrice":1.500,"reason":"damaged" } ] }
```
**`/api/sync/stock-transfers`**
```jsonc
{ "partnerId":"…","externalId":"VAN-TRF-0003","fromWarehouseCode":"MAIN","toWarehouseCode":"VAN-001",
  "date":"2026-07-04","lines":[ { "skuCode":"SKU-1","quantity":10 } ] }
```

**Responses** (`runSync` outcome):
- `201` (created) / `200` — success. Body is the **ERP document**, e.g.
  `{ "invoiceId": "...", "invoiceNumber": "INV-778" }` (payments → `{ paymentId, invoiceNumber }`,
  returns → `{ returnId, returnNumber }`, transfers → `{ transferId, transferNumber }`).
- `200` **replay** — `{ "duplicate": true, "externalId": "...", "targetDocumentType": "...",
  "targetDocumentId": "...", "targetDocumentNumber": "..." }`. **Treat identically to success** and
  store the ERP number.
- Error — `{ "error": { "code": "...", "message": "..." } }` with a status from the table below.

**Status / error codes** (from the Hub docs):
```
partner_not_found     404   Unknown partnerId
partner_inactive      409   Partner status is not ACTIVE
missing_external_id   400   externalId required
erp_not_configured    400   No ERP credential/base URL for the partner
validation_error      400   Request body failed validation
unauthorized          401   Bad/missing token or webhook signature
rate_limited          429   Too many requests
erp_call_failed       502   ERP rejected or was unreachable (Hub will retry transient ones)
```
> **Retry contract:** on `502` the Hub has already queued its own retry (`RETRYING`, backoff
> `1m→5m→15m→1h→6h`, then `FAILED`). FlowVan should **not** aggressively re-POST the same document;
> re-POSTing is safe (idempotent) but redundant. Our outbox should mark the row "handed to hub" and
> reconcile status via the webhook / a status poll, not by re-sending. See §5.

### 3.3 Webhook receiver (Hub → Van) — **we must build this**

FlowVan exposes **one** receiver, e.g. `POST /api/v1/webhooks/hub` (public route, no JWT — auth is the
signature). The Hub delivers with:
```
POST <our vanSalesWebhookUrl>
X-Hub-Event-Type: inventory.stock_changed
X-Hub-Timestamp:  1783200000
X-Hub-Signature:  sha256=<hex>              // present only if the endpoint has a secret configured
Content-Type: application/json
{ "eventType": "inventory.stock_changed", "data": { … } }         // shape is ERP-defined
```
Receiver rules:
1. Read the **raw body** first.
2. If `X-Hub-Signature` present → verify `HMAC_SHA256(endpointSecret, "${X-Hub-Timestamp}.${rawBody}")`.
   Reject `401` on mismatch. If our config requires signatures (prod), **reject unsigned**.
3. Parse, dedupe on the event id (Hub may re-deliver on its own retry), enqueue for processing,
   return `2xx` quickly (the Hub treats non-2xx as a delivery failure and retries).
4. Default subscribed events (from provisioning `DEFAULT_WEBHOOK_EVENTS`):
   `sales_invoice.created`, `payment.created`, `sales_return.created`, `stock_transfer.created`,
   `inventory.stock_changed`. For **Van→ERP** documents we *originate*, the `*.created` echoes are
   mostly status confirmation; **`inventory.stock_changed`** is the one that mutates our world (ERP
   adjusted stock → update our warehouse/van balances).

> **Decision needed (D2):** confirm the exact `data` payloads the ERP emits per event (esp.
> `inventory.stock_changed`) from the ERP webhook publisher — not defined in the Hub (it only routes).

---

## 4. Onboarding / connection steps

There are two provisioning paths; both end with a **partner** that has ERP + VAN_SALES credentials
and webhook routes.

### 4.1 ERP-driven (automatic) — `POST {HUB}/api/provisioning/erp/van-sales`
Called by the ERP when an admin creates a Van Sales API key. Auth: `Bearer <HUB_PROVISIONING_TOKEN>`.
Body includes `erpOrganizationId`, `erpBaseUrl`, `erpApiKey`, `partnerName`, and optionally
`vanSalesApiKey`, `vanSalesBaseUrl`, **`vanSalesWebhookUrl`**, `warehouse`, `salesman`, `webhookEvents`.
Returns (once):
```jsonc
{ "success": true, "data": {
  "partnerId": "<uuid>",
  "vanSalesWebhookReceiverUrl": "{HUB}/api/webhooks/van-sales/<partnerId>",
  "erpWebhookReceiverUrl":      "{HUB}/api/webhooks/erp/<partnerId>",
  "erpWebhookSecret": "whsec_…",   // for the ERP to store
  "created": true } }
```
> Note: this call sets up the ERP↔VAN_SALES webhook routes to **our** `vanSalesWebhookUrl`, but it
> does **not** by itself set the **VAN_SALES bearer secret** we authenticate sync with, nor the
> **endpoint signing secret** for webhooks to us. Those are set via the admin credential call (4.2).

### 4.2 Admin (manual) — attach our credential + secret
```
POST {HUB}/api/integrations/partners/{partnerId}/credentials
Authorization: Bearer <ADMIN_API_TOKEN>
{ "systemName": "VAN_SALES",
  "apiBaseUrl":  "https://cashvan-api-…onrender.com",
  "webhookSecret": "<the bearer secret FlowVan will present on /api/sync/*>",
  "webhookUrl":  "https://cashvan-api-…/api/v1/webhooks/hub" }
```
And, to make Hub→Van webhooks **signed**, set a secret on the ERP→VAN_SALES `webhook_endpoints` rows
(the Hub signs each forward with the endpoint's own secret). Confirm the admin route for endpoint
secrets, or agree a single shared `endpointSecret` == our verify secret. **(D3)**

### 4.3 What FlowVan needs to hold (config)
| Key | Where from | Used for |
|---|---|---|
| `HUB_BASE_URL` | ops | building `/api/sync/*` URLs |
| `partnerId` (uuid) | provisioning result / admin | every sync body |
| `vanSyncSecret` | the `VAN_SALES.webhookSecret` we set in 4.2 | `Authorization: Bearer` on sync |
| `hubWebhookSecret` | the endpoint signing secret (D3) | verify `X-Hub-Signature` |

Store secrets encrypted at rest (reuse `common/crypto/secret.util` — same pattern as the ERP + AI keys).

---

## 5. Idempotency, dedup, retry (FlowVan responsibilities)

- **`externalId`** must be **stable per document across retries** and **unique per `sourceDocumentType`**.
  Use our server-assigned document number, namespaced: e.g. `INV:<voucherNumber>`, `PAY:<collectionNumber>`,
  `RET:<voucherNumber>`, `TRF:<voucherNumber>`. (The mobile app already lacks server voucher #s until
  synced — so we push to the Hub **from the backend after the local doc has a server number**, not
  from the device. This matches how `erp-outbox` works today.)
- On `200 duplicate:true` → treat as success, persist the returned `targetDocumentNumber`.
- On `502` → leave the outbox row as `handed_to_hub` and **reconcile later** (webhook status echo or a
  status poll `GET /api/sync/messages?...`), do not hammer. On `4xx` (validation/config) → `dead_letter`
  + surface in the ERP-export/settings UI for a human.
- The Hub also exposes `POST /api/sync/messages/{id}/retry|cancel` and a worker — but those are
  **Hub-admin** operations, not something FlowVan drives.

---

## 6. Field mapping (FlowVan → Hub payload)

FlowVan document → Hub sync body. Sources are our voucher/collection models.

| Hub field | FlowVan source | Notes |
|---|---|---|
| `externalId` | server voucher/collection number (namespaced) | idempotency key |
| `customerCode` | `customer.customerNumber` | ERP business code; preferred over `customerId` |
| `warehouseCode` | van store code (`erp_van_store` / rep van code) | Hub maps van→ERP warehouse via `warehouse_mappings` |
| `paymentMethod` | our method → `CASH\|CARD\|BANK_TRANSFER\|CHECK` | map `cheque → CHECK`, `transfer → BANK_TRANSFER` |
| `items[].skuCode` | `voucher_transactions.item_number` | |
| `items[].quantity` | `item_qty` (**integer**, positive) | Hub requires `int`; confirm we never send fractional unit qty |
| `items[].unitPrice` | line unit price | **MONEY UNITS — see below** |
| `items[].discount` | line discount value | same money unit as `unitPrice` |
| `items[].taxRateId` | ERP tax-rate uuid (from ERP item defaults) | nullable |
| `amount` (payment) | collection amount | **MONEY UNITS** |
| `originalInvoiceNumber` (return) | referenced sale's **server** invoice number | we already require this for returns |

> **Money units (D4 — RESOLVED 2026-07-04: major decimal).** The ERP v1 write endpoints take money as
> **major decimal** (e.g. `1.500`): `src/app/api/v1/sales-invoices/route.ts` does
> `Math.round(item.unitPrice * 1000)` and returns `totalAmount / 1000`; `payments` does
> `Math.round(d.amount * 1000)`. So FlowVan sends **JOD major**. Since **collections are stored in
> fils**, payment `amount = fils / 1000`. Voucher line `unitPrice`/`discount` are already stored major
> (numeric 3dp — `VoucherMoney3dp` migration) so they pass through as-is. Bonus: the ERP uses our
> `externalId` **as the invoice number** and dedupes on it → set `externalId` = our server voucher
> number.

---

## 7. FlowVan implementation plan (phased)

Mirror the existing `erp-sync` module structure. New module: `src/modules/hub-sync/`.

**Phase 0 — Config & settings**
- Add `app_settings` columns (jsonb or discrete, mirror the ERP-key pattern): `hub_enabled`,
  `hub_base_url`, `hub_partner_id`, `hub_sync_secret_encrypted` + `_last4`, `hub_webhook_secret_encrypted`.
- Add `erp.mode` toggle (`direct | hub`) so exactly one push path is active (D1).
- Settings UI card: base URL, partnerId, sync secret (write-only + last4), webhook secret, a
  "Test connection" button (`GET {HUB}/api/health`).

**Phase 1 — Outbound sync adapter (Van → Hub)**
- `HubHttpClient` — `postSync(kind, body, { bearer })` over `fetch`, parse `{error}` envelope, map
  status → outcome (success / duplicate / retryable / dead-letter).
- `HubSyncService` — subscribe to the same internal events that feed `erp-outbox` today
  (`voucher.posted`, `collection.confirmed`, transfer posted, return posted). Build the payloads via
  `toHubBody(docType, doc)` + `toHubMoney()`. Reuse an outbox table (`hub_outbox` or extend
  `erp_outbox` with a `channel` column) for durability + status.
- Namespaced `externalId`; persist returned ERP `targetDocumentNumber` back onto our doc (like the
  current ERP ref).

**Phase 2 — Inbound webhook receiver (Hub → Van)**
- `POST /api/v1/webhooks/hub` — `@Public()` (signature is the auth), raw-body enabled.
- `HubWebhookController` + `HubWebhookService`: verify `X-Hub-Signature` (constant-time, skew window),
  dedupe by event id, dispatch by `X-Hub-Event-Type`. Handle `inventory.stock_changed` (adjust our
  van/warehouse balances) and `*.created` status echoes (reconcile outbox rows). Return `2xx` fast.
- Confirm ERP event payload shapes (D2).

**Phase 3 — Observability & ops UI**
- Sync-log view (reuse the existing ERP-export / outbox monitor pattern): per-doc status, last error,
  manual "re-hand to hub". Surface `dead_letter` items.

**Phase 4 — Cutover & tests**
- Contract tests against a local Hub (`docker compose up` on 3007, `NODE_ENV≠production` skips
  signature in dev). E2E: post a sale → assert ERP doc number returned; replay → assert `duplicate:true`;
  bad signature → `401`; `inventory.stock_changed` → balance updates.
- Flip `erp.mode` to `hub` for one pilot partner; watch logs; then default.

---

## 8. Decisions / open questions

- **D1** Hub vs direct `erp-sync`: switchable mode; never both push paths for one doc. ✅ proposed.
- **D2** Exact ERP → Hub event payloads (esp. `inventory.stock_changed`). ⛔ confirm with ERP.
- **D3** How Hub→Van webhooks get **signed** (per-endpoint secret vs a shared one) + the admin route to
  set it. ⛔ confirm with Hub admin API.
- **D4** Money units on the ERP v1 write endpoints (major decimal vs integer-thousandths). ⛔ confirm.
- **D5** Do we push from backend only (after server doc numbers exist)? ✅ yes (matches `erp-outbox`).
- **D6** `warehouseCode`/van mapping ownership — the Hub maps via `warehouse_mappings`; we send our van
  code. Confirm mappings are provisioned per van/salesman.
- **D7** *(found in Phase 1)* **Payment semantics.** Direct mode posts a **customer receipt** (ERP
  `/api/v1/receipts`, balance-level). The Hub only exposes `/api/sync/payments` → ERP `/api/v1/payments`,
  which is **invoice-level** (`invoiceNumber?`). Our collections are balance-level, so `buildHubPayment`
  currently sends `amount + paymentMethod + notes` with **no** invoice link. ⛔ Confirm the ERP
  `/api/v1/payments` accepts an unlinked (on-account) payment, else request a Hub `receipts` sync
  endpoint, or attach an `invoiceNumber` when the collection references one.
- **D8** *(found in Phase 1)* **Tobacco tax stripped via Hub.** `buildSale` emits `isTobaccoLine`,
  `tobaccoTaxProfileId`, `consumerPrice` for tobacco lines. The Hub's `syncSalesInvoiceSchema` item only
  allows `skuCode/skuId/quantity/unitPrice/discount/taxRateId` and **strips** the tobacco fields, so
  tobacco lines lose their special-tax context through the Hub. ⛔ Extend the Hub sync schema to pass
  tobacco fields through, or keep tobacco vans on the direct path.

### Phase 1 status — DONE (2026-07-04)
Implemented in the existing `erp-sync` module (routes through the Hub when `hub_enabled`, else direct):
- `hub-http.client.ts` — `HubHttpClient.postSync(path, body)` → `POST {hub}/api/sync/<path>` (Bearer sync
  secret, injects `partnerId`), same result shape as `ErpHttpClient.post`; `isActive()` guard.
- `erp-outbox.service.ts` — `HUB_KINDS = {SALE_INVOICE, SALES_RETURN, PAYMENT, STOCK_TRANSFER}`; `pushOne`
  picks Hub vs ERP; `buildCalls(row, useHub)` reuses `buildSale`/`buildReturn` and adds `buildHubPayment`
  (invoice-level, fils→major) + `buildHubTransfer` (single `stock-transfers` doc). `extractResultRef`
  handles the Hub replay (`targetDocumentNumber`). Unsupported kinds (SALES_ORDER / STOCK_ADJUSTMENT /
  CASH_SETTLEMENT) always go direct.
### Phase 2 status — DONE (2026-07-04)
Inbound receiver in the `erp-sync` module:
- `main.ts` → `NestFactory.create(AppModule, { bufferLogs: true, rawBody: true })` so `req.rawBody` is
  available for signature verification.
- `hub-webhook.controller.ts` — `@Public() POST /api/v1/webhooks/hub`, reads `req.rawBody`, passes the
  raw bytes + headers to the service; sets the exact status/body via `@Res()`.
- `hub-webhook.service.ts` — verifies `X-Hub-Signature = sha256=HMAC_SHA256(hubWebhookSecret,
  "${X-Hub-Timestamp}.${rawBody}")` (constant-time, ±5 min skew; dev-allows when no secret, prod-denies),
  dedupes on a unique `dedupKey` (payload `id`/`data.externalId`, else a body hash), records the event,
  and dispatches by type. `inventory.stock_changed` and the `*.created` echoes emit internal
  EventEmitter2 events (`hub.<eventType>`); unknown types → `ignored`. Returns `2xx` fast.
- `hub_webhook_events` table (migration `1720700000000`) = idempotency guard + audit log.
- Signature scheme unit-verified against the Hub's `computeWebhookSignature` (valid accepted;
  tampered/wrong-secret/wrong-timestamp rejected).

> **Still gated on D2:** `inventory.stock_changed` currently emits an internal event + logs but does
> **not** mutate van/warehouse balances yet — the exact ERP `data` payload must be confirmed before a
> stock handler subscribes to `hub.inventory.stock_changed` and applies it.

### Phase 3 status — DONE (2026-07-04)
Observability for the inbound side (the outbound outbox already has the ERP-Export monitor):
- Backend: `GET /erp/hub-webhooks?status=` (recent inbound events) + `POST /erp/hub-webhooks/:id/reprocess`
  (re-run dispatch for an errored/ignored event), admin-only, on the existing `erp-sync` controller.
  `HubWebhookService.list()` + `reprocess()`.
- Frontend: an **Inbound events** log on the Settings → Integration Hub tab (`HubEventsCard`) — a table of
  event type / status badge / ref / received-at, a **Reprocess** action on `error` rows, auto-refresh
  every 20s. Bilingual (`settings.hub.events*` / `col*` keys). Outbound Hub pushes remain visible in the
  existing ERP-Export outbox monitor (same `erp_outbox` rows).

### D2 stock handler — DONE (2026-07-04)
**D2 resolved from the ERP source** (`ERP/src/app/api/v1/openapi.json/route.ts`): `inventory.stock_changed`
`data = { skuId, warehouseId, quantityChanged, newStockLevel }` (ERP uuids + signed delta + absolute level).
FlowVan stock is **voucher-derived**, and it already mirrors the ERP movement ledger per store
(`ErpSyncService.pullMovementsForStore` → creates a real cash-van voucher per ERP movement, idempotent via
the per-store cursor + `movement` id-map). So the handler does **not** trust the single delta (which would
mean mapping ERP uuids + risking double-count vs. the poller); instead it **triggers the idempotent ledger
pull in real time**:
- `HubWebhookService` emits `hub.inventory.stock_changed`.
- `ErpSyncService.@OnEvent('hub.inventory.stock_changed') onHubStockChanged()` → coalesced
  `drainHubStockSync()` → `pullAllMovements()` (extracted from `syncNow`) → per-store mirror. Event bursts
  collapse into one drain; nothing double-applies.

> Requires ERP **read** access configured (`erpSyncEnabled` + key) even in Hub mode — the Hub routes
> documents + pushes event notifications, but stock is reconciled by pulling the ERP movement ledger
> directly (the ERP is stock master). `pullAllMovements` no-ops when ERP read is off.

**Phases 0–3 + the D2 stock handler are all done.** Remaining are external decisions only: **D3** (how
Hub→Van webhooks get signed) and **D7** (Hub payments are invoice-level vs. our balance-level collections).

## 9. Security checklist
- [ ] Verify `X-Hub-Signature` on every inbound webhook; reject unsigned in production.
- [ ] Constant-time HMAC compare; reject stale timestamps (±5 min).
- [ ] Store `vanSyncSecret` + `hubWebhookSecret` encrypted at rest.
- [ ] Webhook receiver is `@Public()` but rate-limited; never trust body before signature check.
- [ ] Never log secrets or full card/cheque data; redact payloads in outbox/logs.
- [ ] Enforce HTTPS to the Hub; the Hub enforces SSRF + HTTPS in prod.

## 10. Reference — Hub endpoints used by FlowVan
```
GET    {HUB}/api/health
POST   {HUB}/api/sync/sales-invoices      (Bearer VAN secret)
POST   {HUB}/api/sync/payments            (Bearer VAN secret)
POST   {HUB}/api/sync/sales-returns       (Bearer VAN secret)
POST   {HUB}/api/sync/stock-transfers     (Bearer VAN secret)
POST   {HUB}/api/webhooks/van-sales/{partnerId}   (X-Van-Signature)   [non-document events, optional]
—      {HUB}/api/webhooks/erp/{partnerId}          (ERP → Hub; not ours)
GET    {HUB}/api/openapi.json             (full machine contract)
```
FlowVan-hosted:
```
POST   {FLOWVAN}/api/v1/webhooks/hub       (verify X-Hub-Signature)   [to build]
```
