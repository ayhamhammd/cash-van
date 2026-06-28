# ERP ⇄ Cash-Van — Full Two-Way Mirroring Spec

> Goal: the **warehouse-management program (ERP / erp-saas)** and the **cash-van system**
> (admin dashboard + backend + FlowVan app) complement each other — create a salesman, item,
> or any voucher in *either* app and it mirrors into *both* databases. ERP transactions that
> touch a **salesman's (van) warehouse** show on the dashboard; ERP transactions on **other**
> warehouses do **not**.
>
> Builds on: `docs/ERP-INTEGRATION.md` (toggle/connection), `docs/ERP-SYNC.md` (hub design),
> `ERP/docs/CASHVAN-INTEGRATION.md` (ERP API). This doc supersedes the earlier one-direction view.

---

## 0. What already exists (done & verified)
- Connection + on/off toggle on `app_settings`; dashboard **Settings → ERP** tab (test, sync-now, status, outbox, van-store map).
- **Inbound:** items (`/skus` → `item_cart`), van stock (`/van/stock` → cash-van van balance via adjustment vouchers).
- **Outbound (`erp_outbox` + worker):** SALE → `/sales-invoices`, RETURN → `/sales-returns` (idempotency = voucher number = ERP `externalId`; ERP invoice # stored in `erp_id_map`).
- Mapping tables: `erp_id_map`, `erp_store_map`, `erp_sync_cursor`, `erp_outbox`, `erp_sync_runs`.

## What this spec adds
1. **Salesman ↔ warehouse** two-way (create rep on dashboard → ERP van warehouse, and ERP warehouse → rep).
2. **Shared MAIN warehouse** (cash-van MAIN == ERP main/default warehouse).
3. **Items & all voucher types** mirror **both** directions.
4. **Warehouse-scoped visibility**: ERP docs on a van warehouse → dashboard; others → ignored.

---

## 1. Source of truth & identity mapping

| Entity | Master | Cash-van | ERP | Sync key |
|--------|--------|----------|-----|----------|
| Warehouse (depot/van) | **ERP** | `warehouses.wh_number` | `warehouses.code` (+`isVan`) | warehouse **code** |
| Salesman (rep) | **cash-van** | `reps` + the rep's van store | a **van warehouse** (1 rep ↔ 1 van) | rep ↔ van warehouse code |
| **Main** warehouse | **ERP** | `MAIN` store | ERP default/main warehouse | mapped once at setup |
| Item | either (mirrored) | `item_cart.item_number` | `product_skus.sku` | **sku** / barcode |
| Customer | either (mirrored) | `customers.customer_number` | `customers.code` | **code** |
| Voucher / document | either (mirrored) | `voucher_headers.voucher_number` | document + `externalId` | voucher number = `externalId` |

`erp_store_map { erp_warehouse_code, cashvan_store_number, is_van, rep_id? }` is the warehouse bridge.
`erp_id_map { entity, erp_id, erp_code, local_id }` bridges items/customers/vouchers.

---

## 2. Salesman ↔ Warehouse (two-way)

**Rule:** every cash-van **salesman owns exactly one ERP "van" warehouse**; the rep's van store
and the ERP warehouse are the same place. The **MAIN** warehouse is shared (one main in both).

### 2a. Create salesman on the dashboard → ERP
On rep create (cash-van), when ERP mode is on:
1. create/ensure the rep's **van store** locally (`wh_number` e.g. `VAN-07`);
2. **`POST /api/v1/warehouses`** on the ERP `{ code: "VAN-07", name, isVan: true, branchId? }`;
3. (optional) create a **warehouse-scoped API key** for that van;
4. write `erp_store_map` + `erp_id_map(entity:'warehouse')`.
Idempotent: re-running finds the existing warehouse by code (ERP returns it).

### 2b. Create (van) warehouse on the ERP → dashboard
Inbound pull / webhook `warehouse.created`:
1. **`GET /api/v1/warehouses?updatedSince=`** → for each `isVan` warehouse not yet mapped,
2. create a cash-van **van store** + a **rep** (or leave the rep unlinked for an admin to assign),
3. write the mapping.
Non-van warehouses (depots/branches) are pulled as **stores only** (no rep) — used for the shared MAIN and for visibility filtering, never shown as salesmen.

### 2c. Shared MAIN
At setup the admin maps cash-van `MAIN` ↔ the ERP main/default warehouse (one row in `erp_store_map`, `is_van=false`). Inventory and non-van transactions reference this same main on both sides.

---

## 3. Items (two-way mirror)
- **Dashboard creates an item** → mirror to ERP **`POST /api/v1/products`** (base unit sku) → store `erp_id_map(item)`. (Tag origin so the return webhook/pull doesn't re-create it.)
- **ERP creates an item** → existing inbound `/skus` pull (+ `item.created` webhook) → upsert `item_cart`.
- Net: an item created in either app exists in both, keyed by **sku**. Units mirror via the product's unit conversions.

## 4. Customers (two-way mirror)
- Dashboard create → **`POST /api/v1/customers`** (code = customer_number, idempotent).
- ERP create → pull `/customers` (+ webhook) → upsert. Keyed by **code**.

---

## 5. Vouchers / documents (two-way)

### 5a. Cash-van → ERP (outbound, via `erp_outbox`)
| Cash-van voucher | ERP document |
|---|---|
| SALE | `POST /sales-invoices` ✅ |
| RETURN | `POST /sales-returns` (refs original ERP invoice) ✅ |
| ORDER | `POST /sales-orders` (resolve customer/sku UUIDs via id-map) |
| TRANSFER | `POST /stock-transfers` (from/to warehouse via `erp_store_map`) |
| IN (van load) | `POST /stock-transfers` MAIN → van |
| OUT (van unload) | `POST /stock-transfers` van → MAIN |
| Collection | `POST /payments` (per ERP invoice) |
`externalId = voucher number` → ERP dual idempotency → safe retries, no duplicates.

### 5b. ERP → Cash-van (inbound) — **the warehouse-scoped visibility rule**
A poller/webhook ingests ERP documents, but **only those touching a mapped warehouse**:
- ERP doc on a **van** warehouse (mapped to a rep) → create the matching cash-van voucher in that rep's van store, **so it shows on the dashboard** (e.g. a sale entered in the ERP against Van 07 appears as Van 07's voucher).
- ERP doc on the **shared MAIN** → reflect as a MAIN movement (stock), shown in stock/operations.
- ERP doc on **any other** warehouse (a depot/branch with no van mapping) → **ignored** (not pulled, never on the dashboard).
- Dedup by `externalId`/`erp_id_map` so a doc the cash-van itself pushed isn't re-imported (no echo).

> Net effect the user asked for: *"transactions from the ERP related to a sales rep's warehouse appear on the dashboard; those that don't, won't."*

---

## 6. Stock (two-way, reconciled)
- ERP van/main stock → cash-van balances (inbound stock sync ✅, extend to MAIN).
- Cash-van van transactions → ERP stock (outbound ✅ for sale/return; add IN/OUT/TRANSFER).
- Nightly **reconciliation** compares per-(warehouse,item) and flags drift in `erp_sync_runs`.

---

## 7. Loop prevention, idempotency, concurrency
- **Idempotency both directions:** outbound uses `externalId`=voucher number; inbound dedups by `erp_id_map`/`externalId`. A record created by sync is **tagged with its origin** and never pushed back.
- **One authority per field:** ERP owns warehouse/item/stock fields; cash-van owns rep + field-voucher fields. Mirrors copy, never fight.
- **Concurrency:** the outbox worker + inbound poller are single-flight (guarded), use DB upserts keyed by the sync keys, and a new salesman's warehouse/key/stock are provisioned transactionally before their first voucher.
- **No hard deletes on sync** — deactivate; never below-zero stock unless policy allows.
- Money ×1000 ↔ fils/JOD converted once at the boundary; units via multiplier.

---

## 8. ERP-side endpoints required (must be added by the ERP team)
Today the ERP exposes reads + writes for customers/products/sales-invoices/returns/orders/payments/stock-transfers, but **not** warehouses or salesmen. To unblock this spec the ERP must add:
1. **`POST /api/v1/warehouses`** `{ code, name, isVan, branchId? }` (idempotent on code) — for §2a.
2. **`GET /api/v1/warehouses?updatedSince=&includeArchived=`** returning `{ id, code, name, isVan, isMain, updatedAt }` — for §2b + the shared MAIN.
3. **Document feed/webhooks carrying the warehouse**: `sales_invoice.*`, `sales_return.*`, `stock_transfer.*`, `inventory_movement.*`, `warehouse.*`, `item.*`, `customer.*` → so cash-van can apply the §5b visibility filter. Either webhooks (nudge + payload incl. `warehouseCode`) or `GET` list endpoints filterable by `warehouseCode` + `updatedSince`.
4. `updatedSince` on the existing read lists (cheap deltas).
(Recommended: a warehouse-scoped API key per van; the ERP already supports `apiKeys.warehouseId`.)

## 9. Cash-van side (build list)
- **Hooks:** rep create → push warehouse; item create → push product; customer create → push customer; voucher create → outbox (all kinds).
- **Inbound:** extend `ErpSyncService` with `pullWarehouses()` (→ stores/reps), keep `pullItems()`/`pullStock()`, add `pullDocuments()` filtered by mapped van/main warehouses → create vouchers (dedup by externalId).
- **Webhook receiver** `POST /erp/webhook` (HMAC) → enqueue targeted pulls.
- **UI:** dashboard store-map editor (warehouse ↔ van/rep, mark MAIN), origin badges ("from ERP"), outbox/inbox views (have outbox; add inbound document log).

---

## 10. Phasing
1. **Warehouses + salesman↔warehouse two-way** + shared MAIN (needs §8.1–2). *Highest priority.*
2. **Items + customers** two-way mirror.
3. **Vouchers**: finish outbound (ORDER/TRANSFER/IN/OUT/payment) + inbound documents with the §5b visibility filter.
4. **Stock reconciliation + webhooks** (near-real-time, drift job).

## 11. Acceptance
- Create a salesman on the dashboard → a matching **van warehouse** appears in the ERP (and vice-versa); their MAIN is the same warehouse on both.
- Create an item/customer/invoice in **either** app → it appears in **both** databases (one record, mapped, no duplicate).
- A sale entered in the **ERP against a van** warehouse shows on the dashboard for that rep; a sale on a **non-van** warehouse does **not**.
- Stock stays consistent both ways; retries/replays never duplicate (externalId/id-map).
- With ERP mode **off**, none of this runs — cash-van is fully standalone.
