# ERP Integration — Spec (cash-van ⇄ erp-saas)

> Status: **DRAFT** — settings toggle implemented (this PR); sync engine designed below (next).
> ERP app: `/Users/jehadalomour/IdeaProjects/ERP` (Next.js + Drizzle, multi-tenant SaaS).
> Cash-van: this repo (NestJS BE) + `cash-van-dashboard-frontend` + `FlowVan` mobile.

The ERP is the **stock master**. When ERP mode is ON, the cash-van system **pulls** its catalog
(items, units, warehouses incl. the van store, and per-warehouse stock) from the ERP and treats
them as read-only mirrors. When OFF, cash-van manages items/units/stores **standalone** (today's
behaviour). A single settings flag switches between the two.

---

## 1. The ERP already exposes a public API (no ERP changes needed to start)

Bearer **API-key** auth (`Authorization: Bearer erp_<hex>`), per-key **scopes**, rate-limiting,
request logs, and webhooks. Relevant read endpoints (all org-scoped by the key, prices are
integer **×1000**):

| ERP endpoint | Scope | Gives us |
|--------------|-------|----------|
| `GET /api/v1/health` | none | connectivity test |
| `GET /api/v1/products?page&pageSize&search&code` | `products:read` | item master (code, name, category, prices, tax) |
| `GET /api/v1/skus?page&pageSize&code&barcode` | `products:read` | **SKUs** (sku, label, barcode, prices, stockLevel) — our "items" |
| `GET /api/v1/inventory/stock?skuCode&warehouseName&page` | `inventory:read` | per-warehouse on-hand (qty, reserved, available, wac) + warehouse name |

Unit conversions (`unit_conversions`: name, multiplier, isBase) are per-product in the ERP; expose
them either by extending `/skus` or adding `GET /api/v1/units` (small ERP add — see §6).

---

## 2. Entity mapping (ERP → cash-van)

| Concept | ERP source | Cash-van target | Sync key |
|---------|-----------|------------------|----------|
| Item | `product_skus.sku` (+ `products` for name/category) | `item_cart.item_number` | **`sku`** (stable, org-unique) |
| Barcode | `product_skus.barcode` | item barcode | `barcode` |
| Price | `product_skus.selling_price` (×1000) | item price (fils / JOD major) | — convert ×1000 → minor units |
| Tax | `products.tax_rate_id` → rate | item `tax_percentage` | resolve rate value |
| Unit | `unit_conversions{name,multiplier,isBase}` | `item_units{unitCode,unitName,unitBaseQty}` | `(sku, unit name)` |
| Warehouse / store | `warehouses{id,name}` | cash-van warehouse (`wh_number`,`wh_name`) | **warehouse name** (ERP has no code — or add one, §6) |
| Van store | a `warehouses` row named e.g. "Van 001" | cash-van van store mapped to a rep | mapping table (§4) |
| Stock on hand | `item_stock{sku_id,warehouse_id,quantity}` | `stock_balances{store,item,qty}` | `(sku, warehouse)` |

**Units note:** cash-van uses base pieces; ERP `multiplier` == `unitBaseQty`. `isBase` → the base unit.
**Money note:** ERP stores ×1000; cash-van mixes fils vs JOD-major — convert at the sync boundary
(see the `money-units-mixed-fils-vs-jod-major` rule).

---

## 3. Settings & the ERP-mode toggle (implemented)

Stored on the single-row `app_settings` (mirrors the JoFotara encrypted-credential pattern):

| Field | Meaning |
|-------|---------|
| `erp_sync_enabled` | **the toggle** — work *with* ERP (true) or standalone (false) |
| `erp_base_url` | ERP origin, e.g. `https://erp.example.com` (we append `/api/v1`) |
| `erp_api_key_encrypted` (select:false) | the `erp_...` key, AES-encrypted at rest |
| `erp_api_key_last4` | masked tail for display |
| `erp_last_sync_at` | last successful pull |

Admin endpoints (admin-only, like the rest of `/settings`):
- `GET /settings` → includes an `erp` block `{ enabled, baseUrl, apiKeyLast4, isConfigured, lastSyncAt }` (key never returned).
- `PATCH /settings/erp` → `{ enabled, baseUrl?, apiKey? }` (key encrypted; omit to keep current).
- `POST /settings/erp/test` → server calls `GET {baseUrl}/api/v1/health` (and `/skus?pageSize=1`) with the stored key → `{ ok, message }`.

**Behaviour of the toggle**
- **OFF (default):** items/units/warehouses/stock are managed in cash-van as today. ERP endpoints unused.
- **ON:** the sync engine (below) runs; ERP-sourced items/units/warehouses become **read-only** in the dashboard (badged "from ERP"); local create/edit for those entities is hidden/disabled. Vouchers/collections/routes remain cash-van-owned.

---

## 4. Sync engine (design — next PR)

A new `ErpSyncModule` (cash-van BE) that, when `erp_sync_enabled`, pulls from the ERP and upserts.

**Store/warehouse mapping** — small table `erp_store_map { erp_warehouse_id|name, cashvan_store_number, is_van, rep_id? }` so admins map each ERP warehouse to a cash-van store (and tag the van stores → reps).

**Pull jobs (idempotent upserts, keyed by sku / warehouse):**
1. **Items** — page `/skus` (+ `/products` for name/category/tax) → upsert `item_cart` by `item_number = sku`; archived SKUs → deactivate.
2. **Units** — from unit conversions → upsert `item_units` per item.
3. **Warehouses** — `/inventory/stock` distinct warehouses (or `/warehouses` if added) → upsert cash-van stores via `erp_store_map`.
4. **Stock** — `/inventory/stock` → upsert `stock_balances` per (mapped store, item). The **van store** stock comes from the ERP warehouse that represents the van.

**Triggers:** (a) manual "Sync now" button; (b) scheduled poll (e.g. every 10–15 min); (c) optional ERP **webhook** (`item.created`, `stock.updated`, `warehouse.changed`) → cash-van `POST /erp/webhook` for near-real-time. Record results in an `erp_sync_runs` log.

**Direction:** read-only pull for catalog/stock in v1. (Pushing van sales back to the ERP as stock issues/transfers is a later phase — out of scope here.)

---

## 5. Conflict & safety rules

- ERP is authoritative for item/unit/warehouse/stock fields it owns; cash-van-only fields (e.g. rep assignment, journey-plan notes) are preserved across syncs.
- Never hard-delete on sync — deactivate missing/archived records.
- Money/units converted exactly once at the boundary; never below 0 stock unless policy allows.
- All ERP calls use the stored key over HTTPS; the key is encrypted at rest and never returned by the API.
- Sync is **no-op** when the toggle is OFF, so standalone deployments are unaffected.

## 6. Optional small ERP-side additions (when we own that repo)
- `GET /api/v1/units` (per product/sku unit conversions) — avoids over-fetching `/skus`.
- `GET /api/v1/warehouses` with a stable `code` field — cleaner warehouse sync key than name.
- Webhook event types `item.*`, `stock.updated`, `warehouse.*` (infra already exists).

## 7. Acceptance (settings — this PR)
- `GET /settings` returns the `erp` block with the key masked.
- `PATCH /settings/erp` toggles `enabled`, stores `baseUrl`, encrypts `apiKey`, exposes `last4`.
- `POST /settings/erp/test` reports reachability using the stored credentials.
- Dashboard Settings shows an **ERP integration** section: enable toggle, base URL, API key (masked), Test connection, last sync.
