# Connecting ERP ↔ VanFlow (Cash Van)

**A step-by-step runbook for wiring the ERP to the VanFlow dashboard + mobile app.**

This guide covers the full connection: VanFlow **pulls** master data from the ERP over the
API-key REST API, and the ERP **pings** VanFlow (a lightweight webhook) so changes reflect
near-instantly instead of waiting for the periodic poll. There is **no Integration Hub** — it
was removed; this is a direct, two-credential connection.

---

## 1. How it works (architecture)

```
              ┌──────────────────────────────────────────────┐
              │                     ERP                        │
              │   (Next.js, api-key REST API + org data)       │
              └──────────────────────────────────────────────┘
                   ▲  pull (every change + safety poll)  │
   Authorization:  │  GET /api/v1/{organization, warehouses,  │  ping on change
   Bearer erp_…    │  items, customers, prices, receipts, …}   │  POST /api/v1/erp/webhook
                   │                                           ▼  x-webhook-secret: …
              ┌──────────────────────────────────────────────┐
              │                  VanFlow (Cash Van)            │
              │   NestJS backend  +  Next.js dashboard  +      │
              │   Kotlin mobile app                            │
              └──────────────────────────────────────────────┘
```

* **Pull direction — VanFlow → ERP.** VanFlow calls the ERP's v1 API with an **API key**
  (`Authorization: Bearer erp_…`) to pull organization info, warehouses, items, customers,
  prices, categories, units, stock movements, receipts, tobacco profiles. It runs on a safety
  poll every ~5 minutes and on demand ("Sync now").
* **Push/notify direction — ERP → VanFlow.** Whenever data changes in the ERP, the ERP fires a
  fire-and-forget POST to VanFlow's webhook receiver with a **shared secret** header. VanFlow
  ignores the body and simply triggers an immediate re-pull. A missed ping is harmless — the
  poll reconciles it.

**Two credentials, two directions:**

| Direction | Credential | Where it lives |
|---|---|---|
| VanFlow pulls from ERP | ERP **API key** (`erp_…`) | VanFlow → Settings → ERP |
| ERP notifies VanFlow | Shared **webhook secret** | ERP env `VANFLOW_WEBHOOK_SECRET` = VanFlow env `ERP_WEBHOOK_SECRET` |

---

## 2. Prerequisites

* The ERP is deployed and reachable over HTTPS (e.g. `https://erp-xxxx.onrender.com`).
* The VanFlow backend is deployed (e.g. `https://cashvan-api-34c6.onrender.com`) with global
  prefix `/api/v1`.
* The VanFlow dashboard is deployed (e.g. `https://vanflow-dashboard-ndi1.onrender.com`).
* You are an **admin** in both the ERP and VanFlow.

---

## 3. Step 1 — Create the ERP API key

1. In the **ERP**, go to **Settings → API Keys**.
2. Click **Create key**.
3. Give it a clear name, e.g. **`Van Sales`** (avoid throwaway names like "test").
4. Select the **Van Sales** scope preset. It must include **all** of these scopes:

   | Scope | Why VanFlow needs it |
   |---|---|
   | `organization:read` | Company info + logo |
   | `products:read` | Items / SKUs |
   | `inventory:read` | Stock levels & movements |
   | `warehouses:read` | Warehouses / stores |
   | `customers:read`, `customers:write` | Customers |
   | `price_lists:read` | Customer & list prices |
   | `payments:read`, `payments:write` | Receipts feed + posting van receipts |
   | `sales_invoices:read`, `sales_invoices:write` | Sales invoices |
   | `returns:write` | Sales returns |
   | `stock_transfers:read`, `stock_transfers:write` | Stock transfers |

   > **Important:** scopes are **immutable after a key is created** — the Edit screen only
   > changes branch/warehouse. If you later find a scope missing, either recreate the key or
   > patch it directly in the DB (see Troubleshooting → *403*).

5. **Copy the full key now** (`erp_…`) — the ERP shows it only once.

---

## 4. Step 2 — Configure the connection in VanFlow

1. In the **VanFlow dashboard**, go to **Settings → ERP**.
2. Turn **Work with ERP** ON.
3. **ERP Base URL** — the ERP's origin **without** a trailing `/api/v1`, e.g.
   `https://erp-xxxx.onrender.com`. (VanFlow appends `/api/v1/…` itself.)
4. **API Key** — paste the `erp_…` key from Step 1.
5. Click **Test** — it should report a successful connection.
6. Save.

---

## 5. Step 3 — Enable real-time notifications (webhook)

This makes ERP changes reflect in VanFlow within seconds instead of waiting for the ~5-minute
poll. Pick one shared secret string (any strong random value) and set it on **both** sides.

### On the ERP (Render → the ERP web service → Environment)

| Key | Value |
|---|---|
| `VANFLOW_WEBHOOK_URL` | `https://cashvan-api-34c6.onrender.com/api/v1/erp/webhook` |
| `VANFLOW_WEBHOOK_SECRET` | *your shared secret* |

### On the VanFlow backend (Render → the cashvan-api service → Environment)

| Key | Value |
|---|---|
| `ERP_WEBHOOK_SECRET` | *the **same** shared secret* |

Save on both; each service redeploys. From then on, any change in the ERP (stock, items,
customers, warehouses, org, categories, prices, invoices, receipts) pings VanFlow to re-pull.

> The URL points at VanFlow because the webhook travels **ERP → VanFlow**. The ERP's own base
> URL is not involved in the destination.

---

## 6. Step 4 — Run the first sync and verify

1. In the VanFlow dashboard → **Settings → ERP → Sync now**.
2. Open the sync status list. Each entity should read **ok**:
   `organization, warehouse, category, unit, item, customer, customer_price, receipts,
   movements:<each store>`.
3. Spot-check: items, customers, and warehouses appear in the dashboard.

---

## 7. Troubleshooting

### `ERP rejected the API key (HTTP 403) on warehouses` / `on receipts`
The key is missing `warehouses:read` and/or `payments:read`. Because ERP scopes are immutable,
fix the **existing** key directly in the ERP database:

```sql
UPDATE api_keys
SET scopes = (
  SELECT jsonb_agg(DISTINCT s)
  FROM jsonb_array_elements(scopes || '["warehouses:read","payments:read"]'::jsonb) AS s
)
WHERE name = '<your key name>';   -- or WHERE key_prefix = 'xxxxxxxx'
```

To connect to the Render Postgres from your machine: Render → the ERP Postgres → **Connect** →
copy the **External Database URL** (host ends in `.<region>-postgres.render.com`), then
`psql "postgresql://…?sslmode=require"`. No redeploy is needed — the API-key check reads live
from the DB. Then **Sync now** again.

Alternatively: revoke the key and create a new one with the corrected **Van Sales** preset, and
paste the new key into VanFlow → Settings → ERP.

### `ERP tobacco-tax-profiles failed (HTTP 404)`
The ERP's `GET /api/v1/tobacco-tax-profiles` endpoint must be deployed. If your ERP build
predates it, that entity stays 404 until the endpoint ships — it does not block the other
entities.

### `movements:<store>` rows stuck on `failed`
Those rows show the **last** run's result. If they failed once (e.g. before the ERP Base URL
was corrected) they keep showing red until movements successfully re-pull. Run **Sync now** and
re-check — a green result overwrites the stale one.

### Dashboard can't reach the API / CORS errors in the browser console
On the VanFlow **backend** Render service, set `CORS_ORIGINS` to the dashboard's exact origin
(e.g. `https://vanflow-dashboard-ndi1.onrender.com`), or `*` to allow all. Confirm the
dashboard's `NEXT_PUBLIC_API_BASE_URL` points at `https://cashvan-api-34c6.onrender.com/api/v1`.

### The webhook doesn't seem to fire
Confirm `VANFLOW_WEBHOOK_SECRET` (ERP) and `ERP_WEBHOOK_SECRET` (VanFlow) are **identical**, and
that `VANFLOW_WEBHOOK_URL` on the ERP is the VanFlow receiver URL above. A quick manual test:

```bash
curl -i -X POST https://cashvan-api-34c6.onrender.com/api/v1/erp/webhook \
  -H "x-webhook-secret: <shared secret>"
# → 200 {"accepted":true}   (a wrong/missing secret returns 403)
```

---

## 8. Reference — environment variables

| Service | Variable | Purpose |
|---|---|---|
| VanFlow backend | `ERP_WEBHOOK_SECRET` | Shared secret the ERP must present to trigger a re-pull |
| VanFlow backend | `CORS_ORIGINS` | Allowed browser origin(s) for the dashboard |
| VanFlow dashboard | `NEXT_PUBLIC_API_BASE_URL` | `https://cashvan-api-34c6.onrender.com/api/v1` |
| VanFlow dashboard | `NEXT_PUBLIC_WS_URL` | `https://cashvan-api-34c6.onrender.com` |
| ERP | `VANFLOW_WEBHOOK_URL` | VanFlow receiver: `…/api/v1/erp/webhook` |
| ERP | `VANFLOW_WEBHOOK_SECRET` | Same value as VanFlow's `ERP_WEBHOOK_SECRET` |

The ERP **API key** itself is **not** an env var on VanFlow — it is entered in the dashboard
(Settings → ERP) and stored encrypted in VanFlow's database.

---

## 9. Entities VanFlow pulls from the ERP

| Entity | ERP endpoint | Scope |
|---|---|---|
| Organization (company info + logo) | `GET /api/v1/organization` | `organization:read` |
| Warehouses / stores | `GET /api/v1/warehouses` | `warehouses:read` |
| Categories | `GET /api/v1/categories` | `products:read` |
| Units | `GET /api/v1/units` | `products:read` |
| Items / SKUs | `GET /api/v1/skus` | `products:read` |
| Customers | `GET /api/v1/customers` | `customers:read` |
| Customer prices | `GET /api/v1/prices` | `price_lists:read` |
| Receipts | `GET /api/v1/receipts` | `payments:read` |
| Stock movements | `GET /api/v1/stock-movements?warehouseCode=…` | `inventory:read` |
| Tobacco profiles | `GET /api/v1/tobacco-tax-profiles` | `products:read` |
