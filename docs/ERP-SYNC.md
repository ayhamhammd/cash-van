# ERP ⇄ Cash-Van Integration — **BE + FE Spec** (cash-van)

> The cash-van backend is the **integration hub**: it pulls catalog/stock from the ERP and pushes
> van sales/returns + collections back. The dashboard adds the admin UI. Mobile is unchanged
> (see `FlowVan/docs/ERP-INTEGRATION.md`). ERP-side contract: `ERP/docs/CASHVAN-INTEGRATION.md`.
> The connection + on/off toggle already exist on `app_settings` (see `docs/ERP-INTEGRATION.md`).

## Principles
- **One authority per number.** ERP owns items/units/warehouses/**stock**; cash-van owns vouchers/collections. Each pushes what it owns; never both edit the same value.
- **Mobile → cash-van → ERP.** Phones only talk to cash-van (existing `/sync`); cash-van relays to the ERP.
- **All sync is a no-op when `erp_sync_enabled = false`.** Standalone deployments are unaffected.

```
ERP ─webhook"changed"→ cash-van ─cursor pull→ upsert items/units/stores/stock → mobile catalog
mobile ─/sync→ cash-van (post voucher/collection) ─OUTBOX→ worker ─idempotent POST→ ERP movement/payment
                              ▲ periodic stock pull brings authoritative on-hand back
```

---

# BACKEND (`ErpSyncModule`)

## Tables (migration)
| Table | Purpose |
|-------|---------|
| `erp_id_map` | `(entity, erp_id, erp_code, local_id)` — translate ERP↔local for items, warehouses, customers, units |
| `erp_store_map` | `(erp_warehouse_code, store_number, is_van, rep_id?)` — admin maps ERP warehouses → cash-van stores/vans |
| `erp_sync_cursor` | `(entity, updated_since, last_run_at)` — incremental pull cursor per entity |
| `erp_outbox` | `(id, kind, ref, payload jsonb, status, attempts, next_attempt_at, error, created_at)` — outbound queue |
| `erp_sync_runs` | append-only log of pulls/pushes (counts, duration, errors) for the dashboard |

## Inbound (ERP → cash-van) — cursor pull + webhook nudge
A scheduled job (`@nestjs/schedule` cron, e.g. every 10 min) when enabled, per entity:
1. **Items** ← `GET /skus?updatedSince=<cursor>&includeArchived=true` (+ `/products` for name/category/tax) → **upsert `item_cart`** by `item_number = sku`; archived → deactivate; store `erp_id` in `erp_id_map`.
2. **Units** ← `GET /units?updatedSince` → upsert `item_units` per item (`unitCode/unitName/unitBaseQty = name/multiplier`).
3. **Warehouses** ← `GET /warehouses?updatedSince` → upsert cash-van stores via `erp_store_map` (admin maps the van).
4. **Stock** ← `GET /inventory/stock?updatedSince` → upsert `stock_balances` per (mapped store, item). Van on-hand comes from the ERP van warehouse.
Advance the cursor only after a page commits. Webhook controller **`POST /erp/webhook`** (verify HMAC) just enqueues an immediate pull for the changed entity — it carries no data.

**Conversions at the boundary (once):** price ×1000 → fils/JOD (mind the mixed-units rule); `multiplier` → pieces/unit. Preserve cash-van-only fields (rep assignment, journey-plan notes) across upserts.

## Outbound (cash-van → ERP) — transactional outbox
- **Write the outbox row in the same DB transaction** that posts the voucher/collection (hook `VouchersService.create` for SALE/RETURN and `CollectionsService.create`). Kinds: `VOUCHER_MOVEMENT`, `COLLECTION_PAYMENT`, `END_OF_DAY`.
- A cron worker drains `erp_outbox` (status `pending|failed`, `next_attempt_at <= now`):
  1. translate via `erp_id_map` (item#→sku, store→warehouseCode, customer#→customerCode),
  2. `POST` to the ERP write endpoint with **`Idempotency-Key` = voucher/collection number**,
  3. on 2xx → `posted`; on retryable error → backoff (`attempts++`, exponential `next_attempt_at`); after N → `dead_letter`.
- Mapping: SALE → ERP `ISSUE` from the van; RETURN → `RECEIPT`; collection → `payment`. End-of-day → reconciliation doc.
- After a successful push, the next inbound stock pull reconciles the authoritative on-hand.

## Admin endpoints (admin role)
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/erp/sync/now` | trigger a full inbound pull immediately |
| `GET` | `/erp/sync/status` | per-entity cursor + last run + counts |
| `GET` | `/erp/outbox?status=` | outbound queue (pending/failed/dead_letter) |
| `POST` | `/erp/outbox/:id/retry` | re-queue one |
| `GET` | `/erp/store-map` · `PUT /erp/store-map` | view/edit warehouse→store(van) mapping |
| `POST` | `/erp/webhook` | ERP change nudge (HMAC-verified; not admin-gated, signature-gated) |

## Read-only enforcement when enabled
When `erp_sync_enabled`, block local create/edit of **items, units, warehouses, stock** (ERP-owned) at the service layer (return 409 "managed by ERP") and hide the UI. Vouchers/collections/routes/customers stay writable.

## Reliability
Idempotency keys on every push · outbox + dead-letter · cursor never skips uncommitted pages · nightly **reconciliation** job (count/checksum compare → flag drift in `erp_sync_runs`) · all ERP calls over HTTPS with the encrypted key · structured logs + metrics per run.

---

# FRONTEND (dashboard)

Extend the existing **Settings → ERP** tab (connection + toggle already shipped) and add an **ERP Sync** view.

- **Sync status panel** (in the ERP tab or a new `/erp` page): per-entity last pull + row counts, last error, **"Sync now"** button (`POST /erp/sync/now`), `lastSyncAt`.
- **Store mapping** editor: list ERP warehouses ↔ cash-van stores, mark which is a **van** and its rep (`erp_store_map`).
- **Outbox view**: reuse the Sync-Inbox UI pattern — table of outbound items (kind, ref, status, error, attempts) with **Retry** and a dead-letter filter.
- **Read-only badges**: when ERP mode is on, show "from ERP" on items/units/stores and hide their create/edit actions (gate with the same flag).
- `api.ts` hooks: `useErpSyncStatus`, `useTriggerErpSync`, `useErpOutbox`, `useRetryErpOutbox`, `useErpStoreMap`, `useUpdateErpStoreMap`; add `endpoints.erp.*`. Types explicit (no `any`). Bilingual labels; RTL; money via `formatJOD`/`formatJODMajor`.

---

## Phase order
1. **Phase 1 — inbound** (items, units, warehouses/van, stock) + status UI + "Sync now". No ERP writes needed → start here.
2. **Phase 2 — outbound** (`erp_outbox` + worker; push vouchers + collections). Needs the ERP write endpoints.
3. **Phase 3 — end-of-day + reconciliation** (summary doc, drift job, dead-letter ops).

## Acceptance
- Toggling ON pulls a new ERP item → it appears in the dashboard catalog and on the mobile voucher screen; archived ERP item → deactivated locally.
- Posting a van sale enqueues an outbox row → worker pushes an idempotent ERP `ISSUE`; replay/retry never duplicates.
- A collection pushes an ERP payment.
- Outbox view shows failures and retries; reconciliation flags any drift.
- With ERP off, none of the above runs and item/store editing works locally as before.
