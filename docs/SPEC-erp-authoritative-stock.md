# SPEC — The ERP is the book of record for stock; VanFlow keeps a persisted mirror

Make the ERP authoritative for warehouse quantities, and **store its answer** in VanFlow instead
of re-asking on every read. The dashboard then has stock that is fast, historical, available when
the ERP is down, and comparable against the local ledger so drift is measured rather than
discovered.

Scope: a new `erp_stock_snapshot` + history, `ErpSyncService.liveErpStock` / `liveErpQtyIndex`,
`MobileService.getItemBalance` / `getOrderStock` / `getVanStock`, the dashboard stock views.
Companion: `SPEC-stock-write-integrity.md` (van pools, which stay local and locked),
`SPEC-per-unit-stock.md`, `SPEC-erp-sync-reconciliation.md`.

---

## 1. What exists today (verified 2026-09-21)

### 1.1 The authority split is already correct — and already written down

`MobileService.getItemBalance` (`mobile.service.ts:250`) states the policy:

> Overlay the ERP's authoritative on-hand for WAREHOUSE stores (the book of record), so an ERP
> in/out/transfer reflects immediately. VAN stores are deliberately left on the local ledger — it
> drops the instant the salesman sells, whereas the ERP lags his un-synced sales (overselling
> risk).

That reasoning is sound and **this spec keeps it**. It is worth restating, because "make the ERP
the real data" cannot mean *all* stock:

- A **warehouse** is loaded, counted and adjusted in the ERP. VanFlow only ever sees warehouse
  movement second-hand, so the ERP is the truth and the local `item_balance` view is structurally
  near-zero for a depot — documented at `vouchers.service.ts:932`.
- A **van** is the opposite. A rep sells offline; the sale exists on a handset for hours before it
  reaches VanFlow and longer before it reaches the ERP. During that window the ERP's figure for
  the van is **stale high**. Treating it as authoritative would let the rep sell goods that are
  already gone — the one error that cannot be fixed by a later sync, because the physical stock is
  not there.

So: **ERP is authoritative for warehouse pools. The local ledger is authoritative for van pools.**
Where they disagree about a van, that disagreement is the interesting number, and §5 surfaces it
rather than resolving it silently.

### 1.2 But it is re-fetched on every read, and it is expensive

`liveErpStock` (`erp-sync.service.ts:3351`), on **every call**:

1. `getErpConfig()` — decrypts the API key;
2. `this.whs.find()` — every warehouse, to build a **name → store** map;
3. `this.erp.listAll('van/stock')` — pages through the **entire** ERP stock snapshot,
   unconditionally. The comment at `:3395` explains why the targeted per-SKU mode was abandoned,
   and the reasoning is right; the cost is that there is no cheap mode left;
4. for every row returned, `await this.resolveStockTarget(r.skuCode)` — **one database query per
   ERP row**, inside the loop.

Callers: `getItemBalance` (`mobile.service.ts:256`) — a mobile request, per item; `getOrderStock`
(`:332`) — the ORDER picker; plus the transfer views, the stock report and stock-request approval.

So one rep opening the order screen triggers a full ERP snapshot download plus thousands of
`item_units` lookups. Two reps doing it at once do it twice. The ERP's own rate limiter is
handled for the outbox (`erp-outbox.service.ts:38`) but nothing paces this path.

### 1.3 Failure is a silent fallback to a stale number

`catch { return { source: 'unavailable', reason: 'fetch_failed' … } }` (`:3402`), and the callers
then keep the local figure. Correct as a safety choice — a read must not fail because the ERP is
down — but the operator is shown a number with **no indication of which authority produced it or
how old it is**. "At source reads 0 while the van is full" is unanswerable from the dashboard
today; it is answered by running an ERP Inventory Recalculate and seeing whether the screen
changes.

### 1.4 Stores are matched by name

`:3373` — `storeByName.set(w.whName.trim(), …)`, because `/van/stock` returns
`warehouseName`, not a code. An ERP-side rename, a trailing space or a different spelling drops
that warehouse's stock **silently**: `if (!store) continue`. No count, no warning.

### 1.5 There is no history

The ERP snapshot exists only for the duration of the request. So "when did this item go to zero
at the depot", "what did we think we had last Tuesday", and "how long has this van been drifting"
have no answer anywhere.

---

## 2. What changes

| | today | after |
|---|---|---|
| ERP stock | fetched per read | **pulled on a schedule into `erp_stock_snapshot`** |
| Reads | ERP round-trip in the request path | **one indexed table read** |
| ERP down | silent fallback to local | snapshot served with **`asOf` and staleness shown** |
| History | none | **`erp_stock_history`, daily + on material change** |
| Warehouse pools | ERP authoritative (live) | **ERP authoritative (snapshot)** — unchanged in principle |
| Van pools | local ledger | **unchanged** — and the ERP figure kept beside it as comparison |
| Unmapped ERP rows | dropped silently | **counted, listed, reported** |
| Store matching | by name | **by code, name as fallback, mismatches reported** |
| Drift | manual ERP recalculate | **measured nightly, alarmed** |

The shape of the answer to "ERP is real, but save it here" is: **the ERP writes, VanFlow mirrors,
every read is served from the mirror, and the mirror always says how old it is.**

---

## 3. Schema

`src/database/migrations/1727700000000-ErpStockSnapshot.ts`

    -- Current mirror: one row per pool. Upserted by the puller; read by everything.
    CREATE TABLE erp_stock_snapshot (
      stock_number     TEXT          NOT NULL,
      item_number      TEXT          NOT NULL,
      stock_unit_code  TEXT          NOT NULL DEFAULT '',
      quantity         NUMERIC(14,3) NOT NULL,
      -- When the ERP's figure was read. Every consumer shows this; a number
      -- without its age is how §1.3 happened.
      as_of            TIMESTAMPTZ   NOT NULL,
      -- Set when the puller ran and this pool was NOT in the snapshot. The row is
      -- kept, not deleted: "the ERP stopped reporting this pool" and "the ERP says
      -- zero" are different facts and must not be conflated.
      missing_since    TIMESTAMPTZ,
      PRIMARY KEY (stock_number, item_number, stock_unit_code)
    );
    CREATE INDEX idx_erp_stock_snapshot_item ON erp_stock_snapshot (item_number);
    CREATE INDEX idx_erp_stock_snapshot_asof ON erp_stock_snapshot (as_of);

    -- History: append-only. One row per pool per day, plus one whenever the
    -- quantity moves by more than the configured threshold.
    CREATE TABLE erp_stock_history (
      id               BIGSERIAL PRIMARY KEY,
      stock_number     TEXT          NOT NULL,
      item_number      TEXT          NOT NULL,
      stock_unit_code  TEXT          NOT NULL DEFAULT '',
      quantity         NUMERIC(14,3) NOT NULL,
      as_of            TIMESTAMPTZ   NOT NULL,
      -- The local ledger at the same instant, so drift is a stored fact rather
      -- than a join that has to reconstruct two moving numbers after the event.
      local_quantity   NUMERIC(14,3)
    );
    CREATE INDEX idx_erp_stock_history_pool_at
      ON erp_stock_history (stock_number, item_number, stock_unit_code, as_of DESC);

    -- Every pull's outcome, including what it could not map. §1.4 and §1.2 become
    -- visible here.
    CREATE TABLE erp_stock_pull_runs (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at      TIMESTAMPTZ,
      trigger          TEXT        NOT NULL,      -- schedule | manual | on_demand
      status           TEXT        NOT NULL DEFAULT 'running',
      erp_rows         INTEGER,
      pools_written    INTEGER,
      pools_missing    INTEGER,
      unresolved_skus  INTEGER,
      unknown_stores   JSONB,                     -- ERP warehouse names that mapped to nothing
      unresolved_sample JSONB,                    -- first 50 sku codes, for diagnosis
      duration_ms      INTEGER,
      error            TEXT
    );

    -- Store matching by code, per §4.4.
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS erp_warehouse_code TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouses_erp_code
      ON warehouses (erp_warehouse_code) WHERE erp_warehouse_code IS NOT NULL;

`erp_stock_history` grows at (pools × days). Partition it monthly on `as_of` from the start —
`rep_location_events` shows both the pattern and, in
`SPEC-location-ingest-integrity.md` §1.2, the trap to avoid — and give it the same retention
setting.

---

## 4. Backend

### 4.1 The puller

New `ErpStockSnapshotService`.

    @Interval(ERP_STOCK_PULL_MS ?? 120_000)     // 2 minutes
    async pull(trigger = 'schedule')

One run = one `listAll('van/stock')`, the whole snapshot, which is what `liveErpStock` already
does — but **once every two minutes instead of once per read**. Then:

1. Resolve stores by code, then name (§4.4). Unmapped ERP warehouse names are collected into
   `unknown_stores`, not dropped in silence.
2. Resolve SKUs **in bulk**: collect every distinct `skuCode` in the payload and fetch
   `item_units` in one `IN (…)` query into a Map, replacing the per-row `resolveStockTarget`
   await. This is the single biggest cost reduction in the spec.
3. Aggregate to pools exactly as `liveErpStock` does today — that mapping logic is correct and
   hard-won, so **move it, do not rewrite it**.
4. Upsert every pool with `as_of = run start`, clearing `missing_since`.
5. Any snapshot row whose `as_of` is older than this run gets `missing_since = now()` if not
   already set. Kept, flagged, never silently zeroed.
6. Write `erp_stock_history` for pools whose quantity changed by more than
   `ERP_STOCK_HISTORY_THRESHOLD` (default: any change), plus a daily row for every pool at 00:05.
7. Close the `erp_stock_pull_runs` row with counts and duration.

Guard the run with `pg_advisory_lock(hashtext('erp_stock_pull'))` and an in-flight flag, the same
belt-and-braces as `ErpOutboxService.drain()`.

A failed pull leaves the previous snapshot intact and records the error. **Stale data plus a
visible age beats no data**, and it is a strict improvement on today's invisible fallback.

### 4.2 Reads become table reads

    // ErpSyncService — same signatures, so no caller changes shape.
    async liveErpQtyIndex(opts): Promise<{ live, asOf, qty }>

`live` becomes "the snapshot is fresh enough" — `as_of` within `ERP_STOCK_MAX_AGE_MS`
(default 10 min) — rather than "an HTTP call just succeeded". `asOf` is the snapshot's, so every
consumer already renders the right age once the field is populated.

The authority rule, unchanged in substance and now in one place:

    resolveQty(pool):
      if pool.store is a van store  → local ledger      (SPEC-stock-write-integrity.md)
      else if snapshot has the pool → snapshot.quantity (ERP is the book of record)
      else                          → local ledger, marked as a fallback

Every stock figure returned to a client carries `{ qty, source: 'erp'|'local', asOf, stale }`.
The dashboard renders the source and the age; the mobile DTO carries them so a rep can be told
"depot stock as of 09:42" instead of a bare number.

**On-demand refresh** replaces the implicit per-read fetch: `POST /api/v1/erp-sync/stock/refresh`
(admin/manager, throttled to one run per 30s) triggers a pull and returns the new `as_of`. The
places that genuinely need the freshest possible figure — stock-request approval, a transfer
about to be raised — call it first and then read the snapshot. Approval is the one operation
where a two-minute-old number can authorise a transfer of goods that are gone, so it refreshes
explicitly rather than relying on the interval.

### 4.3 Van pools: keep local, store the comparison

The puller writes the ERP's van figures into `erp_stock_snapshot` like any other pool. Reads for
a van still answer from the local ledger. The ERP figure is kept purely so the difference is a
stored, queryable fact — which is what makes §5 possible and what the "at source reads 0" problem
needed all along.

### 4.4 Match stores by code

`/van/stock` returns `warehouseName`. `pullWarehouses` (`erp-sync.service.ts:3639`) and
`pushWarehouse` (`:659`) both already work in **codes**, so the code is available on both sides —
populate `warehouses.erp_warehouse_code` there.

Matching order: `erp_warehouse_code` → exact trimmed name → **case-insensitive** trimmed name. Any
ERP warehouse name that matches nothing is recorded in `unknown_stores` and shown on the ERP
status page as "the ERP reports stock for a warehouse VanFlow does not know: `<name>`". A renamed
warehouse becomes a message instead of a slow leak.

### 4.5 The `getVanStock`/`getItemBalance`/`getOrderStock` call sites

Behaviour is unchanged for the caller; only the data source moves. Specifically:

- `getItemBalance` (`:255`) — drop the `liveErpQtyIndex` await from the request path; read the
  snapshot with the other queries.
- `getOrderStock` (`:332`) — same. Keep the existing and correct decision that the **local ledger
  defines membership** (which items the main store carries) while the ERP defines quantity; the
  comment at `:329` explains why, and the snapshot does not change it.
- `getVanStock` (`:160`) — unchanged; van pools are local.

---

## 5. Drift, measured

`StockDriftService`, `@Cron('30 2 * * *')`, one row per disagreeing pool into
`stock_integrity_findings` (defined in `SPEC-stock-write-integrity.md` §3) with all three numbers:
`van_stock.quantity`, the `item_balance` ledger, and `erp_stock_snapshot.quantity`.

Classify, because the classes need different responses:

| pattern | likely cause | action |
|---|---|---|
| warehouse: ERP ≠ ledger | normal — the ledger is not authoritative for depots | informational only |
| van: ERP > local, within a shift | un-synced or in-flight van sales | informational; resolves itself |
| van: ERP > local, older than 48h | sales that never reached the ERP | **alarm** — cross-check the outbox sweep (`SPEC-transactional-outbox.md` §4.5) |
| van: local > ERP | ERP-side movement VanFlow never saw, or ERP `item_stock` not rebuilt from movements | **alarm** — this is the known "at source reads 0" signature |
| pool `missing_since` > 24h | SKU mapping broken, or the item was deleted in the ERP | **alarm** |
| `unresolved_skus` > 0 on every run | `item_units.erp_sku_code` gaps | **alarm**, with the sample |

**Nothing auto-corrects.** A number that rewrites itself is how the current confusion started;
this names the disagreement and lets a person act.

The dashboard gains **ERP → Stock integrity**: the three columns side by side, filterable by
store and by class, with pull-run history and a Refresh button. The question "is the ERP or
VanFlow right about this item" becomes a page instead of an investigation.

---

## 6. Acceptance

1. **Reads make no ERP call.** Open the ORDER picker with the ERP process blocked at the network
   level. Quantities render from the snapshot with a visible `asOf`. Assert zero outbound ERP
   requests in the request path.
2. **Latency.** `GET /v1/mobile/itemBalance` p95 before and after. Report the number; the current
   path downloads the whole ERP snapshot per call, so the improvement should be an order of
   magnitude, and if it is not, §4.1 step 2 was not done.
3. **ERP is authoritative for a depot.** Adjust stock in the ERP. Within one interval the
   dashboard and the mobile item-balance show the ERP figure for the warehouse.
4. **The van is not overwritten.** With the ERP still showing 100 on a van, post an offline sale
   of 10. The van reads 90 everywhere. No path lets 100 back in.
5. **Missing is not zero.** Remove a pool from the ERP snapshot. The row survives with
   `missing_since` set, the previous quantity, and an alarm — it does not read 0.
6. **Unknown store is reported.** Rename a warehouse in the ERP. The next run lists it in
   `unknown_stores` and the status page says so. No stock silently vanishes.
7. **History accrues.** After a week, a pool's quantity over time is queryable and matches the
   ERP's own movement for that period.
8. **Staleness is visible.** Stop the ERP for 30 minutes. Every stock figure shows `stale` with
   its true age; nothing claims to be live.
9. **Approval refreshes.** Stock-request approval triggers a refresh and decides on a snapshot no
   older than the refresh, not on a two-minute-old one.

## 7. Rollout

1. Migration + `ErpStockSnapshotService` writing the snapshot, with **nothing reading it**. Run it
   alongside the live path for a few days and diff the two — the snapshot must match what
   `liveErpStock` returns for the same instant. This is the step that earns the trust to cut over.
2. §4.4 store codes. Populate, then check `unknown_stores` is empty on every client before going
   further; a non-empty list here means a store's stock is already being dropped today.
3. Cut the read paths over to the snapshot, keeping `liveErpStock` behind
   `ERP_STOCK_LIVE_FALLBACK=1` for one release so a client can be reverted without a deploy.
4. §5 drift + the dashboard page.
5. Delete the live-read path once no client has needed the fallback for 30 days. The mapping logic
   moves to the puller and is not duplicated.
