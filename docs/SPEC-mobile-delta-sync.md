# SPEC — Delta sync for the handset: pull what changed, not everything

The app is told *that* its data went stale and then re-downloads the whole catalog, because no
app-facing endpoint can answer "what changed since?". This adds one, for every resource the
handset caches.

Scope: a new `GET /api/v1/sync/pull/:resource`, tombstones, and the cursor the app stores.
Companion: `src/realtime/sync-signal.ts` (the signal this completes),
`SPEC-sync-intake-contract.md` (the write direction).

---

## 1. What exists today (verified 2026-09-21)

### 1.1 The push half is already right

`src/realtime/sync-signal.ts` is correct and is not being changed. It sends a *pointer*, never
rows, and the reasoning it gives — offline is the normal state, one reconciliation path, a
missed signal costs freshness not correctness — holds. Its resource vocabulary is
`offers | customers | stock | items`.

### 1.2 The pull half has no delta

Grepping the whole backend for `updatedSince | updatedAfter | modifiedSince | If-None-Match |
ETag` returns **only** ERP-facing code: `erp_sync_cursors.updated_since`
(`erp-sync-cursor.entity.ts:12`) and its uses at `erp-sync.service.ts:2489`, `:2620`, `:2749`.
So VanFlow pulls incrementally **from** the ERP and offers nothing equivalent **to** the
handset.

What the app has instead:

| resource | endpoint | shape |
|---|---|---|
| items | `GET /v1/items` | `PaginationDto` — `page`/`limit` (max 200)/`search` |
| customers | `GET /v1/customers` | `ListCustomersQuery` |
| offers | `GET /v1/offers/active` | full list |
| van stock | `GET /v1/mobile/van-stock` | full list, no pagination |
| one item | `GET /v1/mobile/items/:itemCode` | single |

So a `sync.required { resource: 'items' }` — which fires on any ERP price change — costs the
handset the entire catalog over a van's 2–3G link. `getVanStock`
(`mobile.service.ts:160`) returns every loaded item with its units in one unpaginated response.

### 1.3 Offset pagination is the wrong tool even for the full pull

`page`/`limit` is an `OFFSET` scan. Two consequences on a catalog being written by ERP sync
while the app is reading it:

- rows **shift between pages** — an insert before the cursor pushes a row from page 3 to page 4,
  and the app never sees it;
- `OFFSET 9800` makes Postgres walk and discard 9,800 rows, so the last pages of a large
  catalog are the slowest, on the worst connection.

### 1.4 Deletions do not propagate

Soft deletes exist (`deleted_at`, and `SPEC`-level behaviour where ERP catalog sync soft-deletes
records the ERP removed). But every app-facing list **filters them out** —
`mobile.service.ts:187` uses `deletedAt: IsNull()`. So a deleted item is simply absent from the
next full pull. That works only *because* the pull is full; the moment it becomes incremental,
absence carries no information and a deleted item stays sellable on the handset forever.
Tombstones are therefore not an optional extra here — they are what makes delta sync correct.

---

## 2. What changes

| | today | after |
|---|---|---|
| Pull shape | full list, offset-paginated | **keyset delta from an opaque cursor** |
| Deletions | invisible | **tombstones: `{ id, deleted: true }`** |
| Cursor | none | opaque, server-issued, stored per resource on the device |
| Full resync | the only mode | **only when the server bumps the resource epoch** |
| Page selection | `page`/`limit` | `since` + `limit`, `nextSince`, `hasMore` |
| Scope | whole catalog | **rep-scoped** — the van's items, the rep's customers |

One endpoint family, one contract, one cursor type for every resource. The app's sync loop
becomes: *for each resource, pull from my cursor until `hasMore` is false; store `nextSince`.*

---

## 3. Schema

`src/database/migrations/1727500000000-DeltaSyncSupport.ts`

    -- Every syncable resource needs updated_at to be indexed, and the tiebreaker
    -- column in the same index, or the keyset predicate cannot use it.
    CREATE INDEX IF NOT EXISTS idx_item_cart_updated      ON item_cart      (updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_customers_updated      ON customers      (updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_item_units_updated     ON item_units     (updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_price_list_items_upd   ON price_list_items (updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_customer_prices_upd    ON customer_prices (updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_offers_updated         ON offers         (updated_at, id);

    -- Epochs. Bumping one tells every device "your cursor for this resource is void,
    -- pull from scratch" — the escape hatch for anything a row-level delta cannot
    -- express (a hard DELETE, a bulk repair, a scope change, a schema change).
    CREATE TABLE sync_resource_epochs (
      resource   TEXT PRIMARY KEY,
      epoch      INTEGER     NOT NULL DEFAULT 1,
      bumped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      reason     TEXT
    );
    INSERT INTO sync_resource_epochs (resource) VALUES
      ('items'),('customers'),('offers'),('prices'),('units'),('routes');

    -- Tombstones for anything that can be HARD-deleted. Soft-deleted rows are
    -- their own tombstone (they still exist, with deleted_at set); a row removed
    -- from the table leaves nothing behind, so it is recorded here by trigger.
    CREATE TABLE sync_tombstones (
      id         BIGSERIAL PRIMARY KEY,
      resource   TEXT        NOT NULL,
      row_key    TEXT        NOT NULL,     -- item_number / customer_number / uuid
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_sync_tombstones_resource_at ON sync_tombstones (resource, deleted_at, id);

Verify per table whether `updated_at` exists before indexing it — `VanStock` and `ItemUnit` are
plain entities, not `BaseEntity`, so some will need the column added with a backfill from
`created_at` and a trigger (or an explicit `@UpdateDateColumn`) to maintain it.

---

## 4. The endpoint

    GET /api/v1/sync/pull/:resource?since=<cursor>&limit=500
    resource ∈ items | customers | offers | prices | units | routes | van-stock

    200 {
      resource: 'items',
      epoch: 3,
      rows:  [ { … }, { id: 'X', deleted: true } ],
      nextSince: 'eyJ0Ijo…',
      hasMore: true,
      serverTime: '2026-09-21T10:00:00.000Z'
    }

    409 { code: 'EPOCH_CHANGED', epoch: 4 }   // cursor is from an older epoch

Auth: `MobileContextGuard`, so the acting rep comes from the token — see
`SPEC-dashboard-voucher-on-behalf.md` §3 for the guard fix this depends on (a caller with no
`repId` currently slips the ownership check).

### 4.1 The cursor

Opaque to the client, base64 of `{ e: epoch, t: updated_at ISO, i: id }`. Keyset, not offset:

    WHERE (updated_at, id) > ($t, $i)
    ORDER BY updated_at, id
    LIMIT $limit

`(updated_at, id)` is a stable total order, so a row inserted anywhere cannot hide behind a
page boundary, and the index in §3 serves the predicate directly at any depth.

`epoch` is carried **inside** the cursor so a stale one is detected on arrival: mismatch →
`409 EPOCH_CHANGED`, and the app restarts that resource from `since=null`. The device does not
have to remember the epoch separately or reason about it.

### 4.2 The commit-order hazard, and the safety lag

This is the part that silently loses rows if it is skipped.

`updated_at` is assigned when the row is written; the row becomes **visible** when its
transaction commits. A transaction that starts at 10:00:00, writes a row stamped 10:00:00, and
commits at 10:00:05 is invisible to a reader at 10:00:02 — and if that reader advances its
cursor to 10:00:03, the row is **never returned again**. ERP catalog sync runs long
multi-statement transactions (`pullItems`, `pullCustomerPricesBulk`), so this is the normal
case here, not an edge case.

Two mitigations, both required:

1. **Never return rows newer than `now() - SAFETY_LAG`** (2 seconds, generous against any
   plausible commit window):

       AND updated_at < now() - interval '2 seconds'

2. **Never advance `nextSince` past the last row actually returned.** Derive it from the last
   row, never from `now()`. If the page is empty, return the cursor unchanged.

The cost is up to 2 seconds of staleness, which is nothing against a sync the app performs on
foreground. The alternative is a class of missing-row bug that is close to undiagnosable in the
field.

### 4.3 Tombstones

Each resource's query is a union of live changes and deletions:

- **soft-deleted rows** — the row is returned with `deleted: true` and nothing else but its key.
  Drop the `deletedAt: IsNull()` filter on these paths *only*; every other read keeps it. The
  ERP prune's soft-delete behaviour (with its two wipe guards, which this spec does not touch)
  is what makes the catalog's tombstones reliable;
- **hard-deleted rows** — from `sync_tombstones`, ordered by `(deleted_at, id)` with the same
  keyset and the same safety lag.

Retention: prune `sync_tombstones` older than **90 days**, and bump the resource epoch when
pruning. A device offline longer than the tombstone window cannot be caught up by deltas, and
the epoch is how it is told to start over rather than quietly keeping a deleted item.

### 4.4 Scope is part of the delta, and it is the subtle part

`items` is scoped to the van's allowed catalog — `allowedItemNumbersForWarehouse`
(`erp-sync.service.ts:630`) already computes it. `customers` is scoped to the rep's
route/region per `SPEC-rep-scoped-users.md`.

A scope **change** is not a row change: reassigning a rep's route does not touch any customer's
`updated_at`, so a delta pull returns nothing and the handset keeps customers it should no
longer see, and never learns about the ones it should. Handle it explicitly:

- store a `scope_version` on `reps`, bumped whenever the van, route, region or price list
  assignment changes;
- include it in the cursor alongside the epoch;
- a mismatch returns `409 EPOCH_CHANGED`, and the app re-pulls that resource in full.

Full re-pull on a route change is correct and cheap — it happens rarely, and the alternative is
a handset selling to the wrong customers.

### 4.5 `van-stock` is a different animal

Quantities change on every sale, including the rep's own. It stays available in full (it is
small — only loaded items) and gains the delta form for the common case where two items moved.
Its authority question is settled separately in `SPEC-erp-authoritative-stock.md`; this spec
only gives it the same transport as everything else.

### 4.6 Deprecate, don't break

`GET /v1/items`, `/v1/customers`, `/v1/offers/active` and `/v1/mobile/van-stock` keep working
unchanged — installed APKs depend on them and the dashboard uses the first two. They are marked
`@ApiOperation({ deprecated: true })` for the mobile use case only, and the mobile contract doc
(`docs/api/13-frontend-bff.md`) is updated to point at `/sync/pull`.

### 4.7 Make the deltas mean something

ERP sync rewrites rows whether or not their content changed, so `updated_at` moves on every
sweep and a "delta" becomes the whole catalog again — the pull would be incremental in shape
and full in practice. In the ERP upsert paths (`pullItems`, `pullCustomers`,
`pullCustomerPricesBulk`), skip the write when every mapped column is unchanged. Measure it:
log rows-examined vs rows-written per sweep. If a quiet day still rewrites the catalog, this
spec has delivered a new endpoint and no saving.

---

## 5. Mobile contract (KMP)

Per-resource local state: `cursor`, `lastPulledAt`, `epoch`.

    suspend fun pull(resource: String) {
      var cursor = store.cursor(resource)
      do {
        val r = try { api.pull(resource, cursor, limit = 500) }
                catch (e: EpochChanged) { store.clear(resource); cursor = null; continue }
        db.transaction {
          r.rows.forEach { if (it.deleted) db.delete(resource, it.id) else db.upsert(resource, it) }
          store.setCursor(resource, r.nextSince)      // same transaction as the rows
        }
        cursor = r.nextSince
      } while (r.hasMore)
    }

Rules:

1. **Rows and cursor commit together.** A cursor advanced without its rows is a permanent hole;
   this is the single most important line in the loop.
2. Upserts are idempotent — a page may legitimately repeat a row (§4.2).
3. `sync.required` triggers a pull of that resource only. On foreground, pull all of them.
4. `409 EPOCH_CHANGED` → wipe that resource's local table and cursor, pull from scratch. Show
   progress; a full catalog re-pull is visible work.
5. `limit` adapts to the link — 500 on wifi, 100 on a slow cellular connection — so one bad page
   does not time out and stall the whole resource.

---

## 6. Acceptance

1. **Delta is small.** Full initial pull of a 12,000-item catalog. Change one item's price. Next
   pull returns **1 row**.
2. **Nothing is missed under concurrent writes.** Run an ERP catalog sweep while a device pulls
   pages of 100. Every changed row reaches the device. Repeat with the safety lag removed and
   confirm the test catches the loss — the test is only worth having if it fails without §4.2.
3. **Deletion propagates.** Soft-delete an item. The device receives `{deleted:true}` and the
   item is no longer sellable.
4. **Hard delete propagates.** Hard-delete a row; the tombstone reaches the device.
5. **Epoch forces a resync.** Bump the items epoch. The next pull is `409`, then a full pull.
6. **Scope change propagates.** Reassign a rep's route. Next customers pull is `409`; afterwards
   the device holds exactly the new route's customers.
7. **Keyset is stable.** Insert 50 rows mid-pagination. No row is skipped; total received ≥ total
   changed.
8. **Bytes.** Measure a day of real traffic before and after. The number to report is bytes per
   device per day; a change that does not move it has not delivered.

## 7. Rollout

1. Migration: indexes, epochs, tombstones, plus `updated_at` where it is missing.
2. `/sync/pull` for `items` and `customers` — the two that dominate the transfer — behind no
   flag, since nothing calls it yet.
3. §4.7, the ERP no-op-write suppression. Ship this **before** the APK, or the first thing the
   new endpoint does in production is stream the whole catalog anyway.
4. APK adopts `/sync/pull` per resource, one resource at a time, falling back to the full
   endpoint on any error until each is proven.
5. `offers`, `prices`, `units`, `routes`, `van-stock`.
6. Deprecation notes and the doc update; remove nothing until the fleet has moved.
