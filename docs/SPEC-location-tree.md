# SPEC — Location tree (Country › Governorate › Area) and salesmen by area

Status: **proposal**. Backend spec. Companion specs:
- Dashboard: `cash-van-dashboard-frontend/docs/SPEC-location-tree-dashboard.md`
- FlowVan app: `FlowVan/docs/SPEC-location-tree-app.md`

---

## 1. What the office asked for

1. A second way to organise locations, as a **tree**:
   ```
   الأردن (Jordan)                      ← COUNTRY  (root)
   ├── عمّان (JO-AM)                     ← GOVERNORATE
   │   ├── الجبيهة                       ← AREA     (customers live here)
   │   ├── ماركا
   │   └── …
   ├── إربد (JO-IR)
   │   ├── الحصن
   │   └── …
   └── …12 governorates
   ```
2. It **replaces** the current location setup (the flat `customer_areas` list), behind a
   **switch**: the company runs either the existing flat areas or the new tree.
3. A salesman can be assigned **to an area** (he gets every customer in it) **or directly
   to an individual customer** (an exception that beats the area).

---

## 2. What exists today (the parts this touches)

Facts read from the code on `dev`; line numbers are approximate.

| Concept | Storage | Used for |
|---|---|---|
| **Customer areas** (المناطق) | `customer_areas` (flat: name_ar, name_en, color, is_active) + `customers.area_id` — migration `1727900000000-CustomerAreas` | Office filter, area chip, the app's area filter and new-shop picker (`GET /customers/areas`), pushed to the ERP as the customer's `address` (`erp-outbox.service.ts buildCustomerArea`) |
| **Regions** | `regions` (code, names, GeoJSON polygon) + `reps.region_id`, `customers.region_id`, `users.region_id` | Offer eligibility (`regionIds`), segment rules, a read-only settings tab. No management UI; nothing assigns customers to them |
| **City** | `customers.city` (free text), `customers.city_code` (JoFotara code, e.g. `JO-AM`) | JoFotara buyer address, journey-plan rows. Not synced with the ERP |
| **Segments** | `customer_segments`, `segment_customers` (one per customer), `segment_reps` (metadata only) | Offers, rules, bulk "assign members to a salesman" |

**Who sees which customer — one column decides everything:** `customers.rep_id`.
- The phone pulls `GET /v1/customers`; for a salesman the controller forces
  `query.repId = user.repId` (`customers.controller.ts:70-80`) and the service filters
  `c.rep_id = :repId` (`customers.service.ts:492-516`).
- Reports, AR, targets and supervisor scoping (`user_rep_scope`) all key on `c.rep_id`.
- The journey plan's `assertCustomerServable` admits a customer only if `rep_id` is null or
  that rep (`journey-plan.service.ts:437-449`).
- Selling / collecting does **not** check ownership (`vouchers.service.ts:1725` — a rep may
  sell to another rep's customer). This spec does not change that.
- `rep_id` is set by: salesman create (forced to himself), the customer form / PATCH (needs
  `customers.assignSalesman`), `POST /customers/:id/reassign`, the Excel
  `POST /customers/assign-salesmen`, and segment `assign-rep`.

> **Design consequence.** Area-based assignment must *resolve into* `customers.rep_id`.
> Then the phone, reports, AR, targets, journey plans and supervisor scope keep working
> with no change at all. Inventing a second ownership path (rep ↔ area joins in every
> query) would mean touching every one of those queries.

---

## 3. Data model

### 3.1 `locations` — the tree

```sql
CREATE TABLE locations (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  parent_id   uuid NULL REFERENCES locations(id) ON DELETE RESTRICT,
  kind        text NOT NULL CHECK (kind IN ('COUNTRY','GOVERNORATE','AREA')),
  path        text NOT NULL,          -- '/<rootId>/<govId>/<areaId>/' — subtree = LIKE path||'%'
  depth       smallint NOT NULL,      -- 0 country, 1 governorate, 2 area
  code        text NULL,              -- governorate: ISO/JoFotara code ('JO-AM'); area: optional office code
  name_ar     text NOT NULL,
  name_en     text NULL,
  color       text NULL,              -- hex, same palette as customer_areas
  sort_order  integer NOT NULL DEFAULT 0,
  rep_id      uuid NULL REFERENCES reps(id) ON DELETE SET NULL,  -- §5: the salesman covering this node
  is_active   boolean NOT NULL DEFAULT true,
  -- BaseEntity: created_at, updated_at, deleted_at, version
  CONSTRAINT chk_locations_root CHECK ((kind = 'COUNTRY') = (parent_id IS NULL))
);
CREATE UNIQUE INDEX uq_locations_sibling_name ON locations (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'), name_ar) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_locations_gov_code     ON locations (code) WHERE kind = 'GOVERNORATE' AND code IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_locations_parent ON locations (parent_id);
CREATE INDEX idx_locations_path   ON locations (path text_pattern_ops);
CREATE INDEX idx_locations_rep    ON locations (rep_id) WHERE rep_id IS NOT NULL;
```

Rules (enforced in `LocationsService`, tested):
- **Fixed three levels.** A child's kind is derived from its parent:
  no parent → `COUNTRY`; parent `COUNTRY` → `GOVERNORATE`; parent `GOVERNORATE` → `AREA`;
  an `AREA` cannot have children. The table is generic (`parent_id` + `path`) so a fourth
  level (e.g. neighbourhood) later is a rule change, not a migration.
- **One active root** for now (Jordan). The CHECK allows only `COUNTRY` without a parent.
- `path`/`depth` are written by the service on insert and on **move** (a move rewrites the
  subtree's paths in one `UPDATE … SET path = :new || substr(path, length(:old)+1)`).
- Delete is **refused** while the node has children or customers (soft delete otherwise).
  Deactivate is always allowed; an inactive area stays on its customers but cannot be
  picked for new ones (same as `customer_areas.assertAssignable` today).
- Size is small (1 + 12 + a few hundred rows), so the whole tree is read in one query and
  cached in memory, invalidated on every write.

### 3.2 Customer columns

```sql
ALTER TABLE customers
  ADD COLUMN location_id uuid NULL REFERENCES locations(id) ON DELETE SET NULL,
  ADD COLUMN rep_source  text NULL CHECK (rep_source IN ('DIRECT','AREA'));
CREATE INDEX idx_customers_location ON customers (location_id);
```

- `location_id` must point at an **AREA** (leaf). A governorate is derived, never stored on
  the customer.
- `area_id` (flat) is **kept untouched**. Both columns live side by side so the switch (§4)
  can go back and forth without losing anything.
- `rep_source` says *why* `rep_id` holds what it holds (§5). Existing rows: `DIRECT` where
  `rep_id IS NOT NULL`, else `NULL` (backfill in the same migration).
- When a customer's area is set in TREE mode, `city_code` is filled from the governorate's
  `code` **if empty** (JoFotara needs it; today most customers have none). `city` (free
  text) is left alone.

### 3.3 Setting

```sql
ALTER TABLE app_settings ADD COLUMN location_mode text NOT NULL DEFAULT 'FLAT'
  CHECK (location_mode IN ('FLAT','TREE'));
```

Follows the `containersEnabled` pattern end to end: entity column, `UpdateSettingsDto`
(`@IsIn(['FLAT','TREE'])`), added to `PROGRAM_FEATURE_KEYS` so it goes through
`PATCH /v1/settings/features` (admin; open while the ERP is connected), `AppSettingsView`,
a server reader `locationMode()`, and **`GET /v1/company-info` → `locationMode`** for the app.

Switching is a **separate endpoint**, not a plain PATCH, because it has side effects (§4.2):
`PATCH /settings/features` rejects `locationMode`; use `POST /v1/locations/mode`.

---

## 4. The switch: FLAT ↔ TREE

### 4.1 What the mode decides

| | FLAT (today) | TREE |
|---|---|---|
| Customer's location | `area_id` → `customer_areas` | `location_id` → `locations` (AREA) |
| Office page | `/areas` | `/locations` |
| App picker / filter | `GET /customers/areas` (flat) | `GET /customers/locations` (tree) — and `GET /customers/areas` keeps working for old app builds (§7.3) |
| Salesman by area | not available | available (§5) |
| ERP `address` push | area name | `"<governorate> - <area>"` |

The data of the inactive mode is **kept, not deleted**. FLAT areas and their members stay
in `customer_areas`/`area_id`; tree nodes and `location_id` stay too.

### 4.2 `POST /v1/locations/mode` `{ mode, dryRun? }` — admin

- **FLAT → TREE**
  - Refused with `409 LOCATION_TREE_EMPTY` if the tree has no AREA. The dashboard offers
    *Seed Jordan* + *Import flat areas* first (§6.2).
  - Recomputes `rep_id` for every customer whose `rep_source = 'AREA'` or who sits in an
    area with a salesman and has `rep_source IS NULL` (§5.3). `dryRun: true` returns
    `{ customersMoved, byRep: [{fromRepId, toRepId, count}] }` without writing, so the
    office sees what will move before confirming.
- **TREE → FLAT**
  - No customer changes owner. `rep_id` keeps its last resolved value; `rep_source = 'AREA'`
    rows become plain owners (rep_source left as is, ignored in FLAT).
  - `locations.rep_id` assignments stay stored and inert.
- Both: write the setting, invalidate caches, emit one `sync.required {resource:'customers'}`
  to every rep (customers' location labels change on every phone) and `settings.changed`.
- Audit row in the existing audit log (migration `1716500000000-AddAuditLogAndNotificationRules`):
  actor, from → to, counts.

---

## 5. Salesmen by area, or directly by customer

### 5.1 Rule

For each customer, in TREE mode:

1. **Direct** — `rep_source = 'DIRECT'`: `rep_id` is what the office (or the creating
   salesman) set. An area change never overrides it.
2. **By area** — otherwise: the salesman of the **nearest node up the path** that has one
   (area → governorate → country). An area with no salesman inherits its governorate's;
   a whole governorate can be given to one salesman with a single assignment.
3. **None** — no node up the path has a salesman: `rep_id = NULL`, `rep_source = NULL`
   (the customer is unassigned, exactly like today).

One salesman per node. Two vans sharing one area is out of scope for v1 (open question
Q1); today a customer has one `rep_id`, and every report depends on that.

### 5.2 Materialised, not computed per query

The resolved salesman is **written into `customers.rep_id`** with `rep_source = 'AREA'`.
Nothing that reads `rep_id` changes: the phone's customer list, reports, AR, targets,
journey plans, supervisor scope, offers.

### 5.3 When `rep_id` is recomputed

All in `LocationRepResolver`, one transaction, `pg_advisory_xact_lock(hashtext('location-reps'))`
so two office users can't interleave:

| Trigger | Customers recomputed |
|---|---|
| `PUT /locations/:id/rep` (assign / clear) | non-DIRECT customers in the node's subtree |
| Area moved to another governorate | non-DIRECT customers in the moved subtree |
| Customer's `location_id` changes (form, members API, import) | that customer, if not DIRECT |
| Customer "back to area salesman" (§5.4) | that customer |
| Mode → TREE | all non-DIRECT customers |
| A rep deactivated / deleted | `locations.rep_id` is SET NULL; its AREA customers recompute (they fall to the next node up, or none) |

One `UPDATE … FROM (resolved) …` statement per trigger — not a loop — so assigning a
governorate with 3,000 customers is one query.

Each recompute returns `{ changed: [{customerId, fromRepId, toRepId}] }` and then:
- one `sync.required {resource:'customers'}` **per affected rep** (both the losing and the
  gaining rep), not one event per customer;
- `customer.changed` for segment rule refresh (batched);
- ERP push of the new salesman (§8.2);
- an audit row with counts.

### 5.4 Direct assignment and going back to the area

- Setting a salesman on the customer (form, `POST /customers/:id/reassign`, Excel
  `assign-salesmen`, segment `assign-rep`) sets `rep_source = 'DIRECT'`. These paths
  exist today; each gets one extra column write.
- A salesman creating a shop on the phone: `rep_id` = himself, `rep_source = 'DIRECT'`
  (unchanged behaviour: the shop he found is his).
- New: `POST /v1/customers/:id/rep-source` `{ source: 'AREA' }` (`customers.assignSalesman`)
  drops the exception: `rep_source = 'AREA'` and recompute. If no node has a salesman the
  customer becomes unassigned; the response says so.
- In FLAT mode `rep_source` is still written (cheap, keeps the data right for a later
  switch) but nothing reads it.

### 5.5 What a salesman sees on the phone

No change to `GET /v1/customers` scoping: `c.rep_id = :repId`. When an area is reassigned,
the old salesman's phone gets `sync.required`, its full refresh replaces the local table,
and those shops disappear; the new salesman's phone gets them. Documents already captured
offline for a shop that just left still sync, because sales/collections don't check
ownership (unchanged).

---

## 6. API

All under `/v1`. Office endpoints reuse the existing permission keys **`areas.view`** /
**`areas.edit`** (no permission migration; the dashboard labels them "Locations").

### 6.1 Tree

| Method / path | Perm | Notes |
|---|---|---|
| `GET /locations?includeInactive=` | areas.view | Flat array: `{id, parentId, kind, depth, code, nameAr, nameEn, color, sortOrder, isActive, repId, repName, inheritedRepId, inheritedRepName, customerCount, subtreeCustomerCount}`. The dashboard builds the tree. `inherited*` = the salesman this node gets from above when its own is empty. |
| `GET /locations/:id` | areas.view | Same shape + `ancestors[]` |
| `POST /locations` | areas.edit | `{parentId, nameAr, nameEn?, code?, color?, sortOrder?}`; kind derived; `400 LOCATION_TOO_DEEP` under an AREA |
| `PATCH /locations/:id` | areas.edit | names/code/color/sortOrder/isActive, and `parentId` (move an AREA to another governorate; a governorate cannot be moved off the root) |
| `DELETE /locations/:id` | areas.edit | `409 LOCATION_HAS_CHILDREN` / `409 LOCATION_HAS_CUSTOMERS` |
| `POST /locations/reorder` | areas.edit | `{parentId, ids[]}` → sort_order |
| `POST /locations/seed-jordan` | areas.edit | Idempotent. Creates الأردن + the 12 governorates with codes (§6.2) and skips any that exist by code |

### 6.2 Seed data and import

Jordan's 12 governorates with their ISO 3166-2 codes (the same codes JoFotara takes as
`cityCode`):

| code | name_ar | name_en |
|---|---|---|
| JO-AM | عمّان | Amman |
| JO-IR | إربد | Irbid |
| JO-AZ | الزرقاء | Zarqa |
| JO-BA | البلقاء | Balqa |
| JO-MA | المفرق | Mafraq |
| JO-JA | جرش | Jerash |
| JO-AJ | عجلون | Ajloun |
| JO-MD | مادبا | Madaba |
| JO-KA | الكرك | Karak |
| JO-AT | الطفيلة | Tafilah |
| JO-MN | معان | Ma'an |
| JO-AQ | العقبة | Aqaba |

Areas are **not** seeded (every distributor names its own).

`POST /locations/import-flat` (areas.edit) — moves a company from FLAT to TREE without
retyping:
```json
{ "mapping": [ { "areaId": "<customer_areas.id>", "governorateId": "<locations.id>" } ] }
```
For each row: create an AREA under the governorate with the flat area's name and colour
(or reuse one with the same name), then set `location_id` on every customer whose
`area_id` is that flat area. Returns `{ created, reused, customersPlaced, unmapped }`.
Idempotent; run as many times as needed. Customers without a flat area are reported, not
guessed.

### 6.3 Members and salesmen

| Method / path | Perm | Notes |
|---|---|---|
| `GET /locations/:id/members?q&limit&offset&subtree=` | areas.view | customers in the area (or the whole subtree) with `repId, repName, repSource` |
| `POST /locations/:id/members` | areas.edit | `{customerIds[] ≤ 2000}`; AREA only; recompute non-DIRECT reps |
| `DELETE /locations/:id/members/:customerId` | areas.edit | sets `location_id = NULL` (the salesman stays as it was) |
| `PUT /locations/:id/rep?dryRun=` | areas.edit **and** customers.assignSalesman | `{repId \| null}`; returns the §5.3 change set. `dryRun` writes nothing |
| `GET /reps/:id/locations` | areas.view | nodes this salesman covers + customer counts (salesman drawer) |
| `POST /customers/:id/rep-source` | customers.assignSalesman | `{source:'AREA'}` (§5.4) |

### 6.4 Customers

- `POST/PATCH /customers` accept **`locationId`** (AREA, active; same `canSetCustomerArea`
  drop rule as `areaId` today for salesmen). In TREE mode `areaId` is still accepted from
  old app builds and translated (§7.3).
- `GET /customers` filters: `locationId` (**subtree**, so a governorate filters all its
  areas), `noLocation=true`. List items get, via one batched attach like `attachAreaNames`:
  ```
  locationId, locationName, governorateId, governorateName, governorateCode,
  locationLabel  ("عمّان - الجبيهة"), repSource
  ```
  `GET /customers/:id` gets the same (today it misses `areaName`; fix both).
- `GET /customers/locations` — **any signed-in user**, for the phone picker: active nodes
  only, as a nested tree `[{id, nameAr, nameEn, code, color, children:[…]}]`.
- Boolean query flags: `noLocation` must parse `"false"` as false. The existing
  `unassigned`/`noArea`/`unsegmented` flags use `@Type(() => Boolean)`, which reads the
  string `"false"` as `true` (not verified against the global pipe). Add a small shared
  `@Transform(({ value }) => value === true || value === 'true')` and use it for all four
  flags, with a test that `?noArea=false` returns customers that have an area.

---

## 7. App contract (detail in `FlowVan/docs/SPEC-location-tree-app.md`)

### 7.1 Config
`GET /v1/company-info` adds `locationMode: "FLAT" | "TREE"`.

### 7.2 Data
Customer list items carry the §6.4 fields. The phone keeps no tree table; the picker reads
`GET /customers/locations` online, like the flat picker does today.

### 7.3 Old app builds keep working (no forced update needed)

App ≤ 1.10 (20) knows only `areaId/areaName` and `GET /customers/areas`. In **TREE** mode:
- `GET /customers/areas` returns the tree's active **AREA** nodes, flattened, with
  `id = locations.id` and `nameAr = "<governorate> - <area>"`.
- List items set `areaId = location_id` and `areaName = locationLabel`.
- `POST /customers` with `areaId`: if it is a `locations.id` of an AREA, treat it as
  `locationId`.

So the old app's area chips and new-shop picker show the tree's areas, flattened. The
new app build shows the two levels (governorate → area).

---

## 8. Everything else that reads location

### 8.1 Unchanged on purpose
- `regions` (polygons) stay as they are: offers' `regionIds`, segment rules. The tree
  doesn't replace map polygons. Offer eligibility by tree node is a follow-up (Q3).
- Journey plans, `assertCustomerServable`, geofence, voucher/collection intake: no change
  in behaviour. One addition: `my-route/today|cycle|day` stops and the journey-plan rows
  carry `locationLabel` next to `city` (same batched attach), so the app's route screen
  and the dashboard's weekly route can show "عمّان - الجبيهة".
- Reports, AR, targets, supervisor scope: no change (they read `rep_id`).

### 8.2 ERP
- **Area push** (`erp.customer.area` → outbox `CUSTOMER_AREA` → `PATCH customers/{id}
  {address}`): in TREE mode send `locationLabel` (`"عمّان - الجبيهة"`). Same event and
  same outbox kind; only the payload builder looks at the mode.
- **Salesman push** — today a reassignment never reaches the ERP (only `salesmanCode` on
  create). An area reassignment can move hundreds of customers, so leaving the ERP stale
  gets worse. Add outbox kind `CUSTOMER_SALESMAN`, drained in batches of ≤ 500 through
  the ERP's existing `POST /api/v1/customers/assign-salesmen`
  `[{customerCode, salesmanCode}]`. A customer moved to *no* salesman has no row in
  that call; it needs an ERP "unassign" (ERP follow-up E1). Applies to every reassignment
  path, not only areas.
- **Governorate code** — the ERP's customer PATCH accepts `address` but **not**
  `cityCode` (`ERP src/app/api/v1/customers/[id]/route.ts`). Sending `JO-xx` to the ERP
  needs an ERP change (follow-up E2). Until then `city_code` is filled on the VanFlow
  side only, for VanFlow's own JoFotara filings.

---

## 9. Migration (one TypeORM migration, `…-LocationTree`)

1. `CREATE TABLE locations` + indexes (§3.1).
2. `customers.location_id`, `customers.rep_source`; backfill `rep_source = 'DIRECT'` where
   `rep_id IS NOT NULL`.
3. `app_settings.location_mode DEFAULT 'FLAT'`.
4. Nothing seeded. Every existing company stays exactly as it is until an admin opts in.

`down()` drops the columns and the table (no customer data lives only there in FLAT mode).

---

## 10. Tests (real DB, like `areas.integration.spec.ts`)

- Tree rules: kind derived from parent; no child under AREA; one root; sibling-name and
  governorate-code uniqueness; move rewrites the subtree's `path`; delete refused with
  children / customers.
- Seed is idempotent; import-flat places members and is idempotent.
- Resolution: area rep wins over governorate rep; empty area inherits the governorate;
  DIRECT survives an area reassignment and an area move; "back to area" falls to the
  inherited rep, or to none.
- Recompute is one statement and emits one `sync.required` per affected rep (both sides).
- Mode switch: TREE refused on an empty tree; `dryRun` writes nothing and its counts equal
  the real run's; TREE → FLAT changes no `rep_id`.
- `GET /customers` as a salesman returns exactly the customers resolved to him.
- Old-app compatibility (§7.3): flat `GET /customers/areas` in TREE mode returns leaves;
  `POST /customers {areaId: <location id>}` lands in `location_id`.
- `noLocation=false` is false.
- ERP: `CUSTOMER_AREA` payload uses the label in TREE mode; `CUSTOMER_SALESMAN` batches.

---

## 11. Phases

| # | Scope | Ships alone? |
|---|---|---|
| 1 | Table, CRUD, seed, import, `location_mode` (FLAT default), customer `locationId` + list fields, picker endpoint, old-app compatibility | Yes — nothing changes until an admin switches |
| 2 | Salesman by area: `locations.rep_id`, `rep_source`, resolver, `PUT /locations/:id/rep`, rep-source reset, mode-switch recompute | Yes |
| 3 | ERP: label in `address`; `CUSTOMER_SALESMAN` outbox | Needs ERP E1 for unassign |
| 4 | Reports: "Sales by governorate / area" (group `c.location_id` up the path) | Later |

---

## 12. Open questions

- **Q1** Two salesmen in one area (e.g. a cold-drinks van and a snacks van)? v1: one per
  node. Supporting it means a customer with more than one `rep_id`, which touches every
  report.
- **Q2** Should salesman-by-area also work in FLAT mode (on `customer_areas`)? v1: TREE only.
- **Q3** Offer eligibility by governorate/area (`locationIds`) next to `regionIds`?
- **Q4** Should a salesman creating a shop in an area covered by another salesman keep it
  (DIRECT, today's behaviour) or hand it to the area's salesman?

ERP follow-ups: **E1** an "unassign salesman" path for `assign-salesmen`; **E2**
`cityCode` on `PATCH /api/v1/customers/:id`.
