# Plan — Customer Segmentation

Shareable version: https://claude.ai/code/artifact/93af66e3-1d86-4f62-89d5-e4bdf107449a

## The idea

One **segment** primitive — a named, reusable set of customers with its own id —
that offers, sales analytics, and salesman assignment all reference, instead of
each feature carrying its own private customer list. Build the group once; reuse
it everywhere.

Today every feature re-invents "these customers": an offer bakes customer numbers
into its own `eligibility` JSON, a rep owns customers one `rep_id` at a time. A
segment turns "these customers" into a first-class object.

## Fit with what exists (reconcile, don't duplicate)

There is **no** segment/group/tag table yet. Three overlapping ideas exist —
make `customer_segments` the one *managed* grouping and let the others feed it:

| Exists | What it is | Relation |
|---|---|---|
| `customer.category` (indexed text) | Free-text label; what an offer's `SEGMENT` scope matches on today | Backfill each distinct category into a real segment; keep `category` as a plain attribute a rule can read |
| `customer_ai_profiles.segment` | Computed RFM tier + churn risk | Stays a computed **insight**; a dynamic rule may reference it, never becomes a managed segment |
| `offer.eligibility` (JSONB) | Per-offer audience (`customerScope`, `segments[]`, `repIds[]`…) | Gains `segmentIds[]`; legacy `segments[]`→category keeps working during transition |

Grounding in current code:
- Offer targeting/matching: `src/modules/offers/offers-engine.service.ts` `isEligible()` (~L564), `offers.types.ts` `OfferEligibility`.
- Customer fields: `src/modules/customers/entities/customer.entity.ts`.
- Rep visibility: `src/modules/users/rep-scope.service.ts` `visibleRepIds()`.

## Data model — three tables (all extend `BaseEntity`)

### `customer_segments`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid (pk) | BaseEntity |
| `name_ar` / `name_en` | text | Bilingual, Arabic-first |
| `description` | text null | |
| `color` | text null | Chip colour in UI |
| `kind` | `STATIC` \| `DYNAMIC` (idx) | Manual list vs rule-driven |
| `rules` | jsonb null | DYNAMIC only (see below) |
| `is_active` | bool (idx) | Soft on/off |
| `is_system` | bool | Backfilled/derived segments the UI protects |
| `created_by` | uuid null | Audit |

### `segment_customers` (the single membership read path)
`segment_id` (fk, idx), `customer_id` (fk, idx), `source` (`MANUAL`\|`RULE`\|`IMPORT`),
`added_by`, `added_at`. **Unique `(segment_id, customer_id)`.**

### `segment_reps`
`segment_id` (fk, idx), `rep_id` (fk), `added_by`, `added_at`.
**Unique `(segment_id, rep_id)`.** Which salesmen own/serve the segment.

## Membership — static + dynamic, one uniform read

**Both kinds resolve to `segment_customers` rows**, so consumers never care how a
customer got in.

- **Static** — admin adds customers explicitly (search, bulk from the customer
  list, Excel). `source = MANUAL`. Never recomputed.
- **Dynamic** — a `rules` object materialised into `source = RULE` rows by a
  refresh, so reads stay identical to static.

Rule shape: `{ match: "ALL"|"ANY", conditions: [{ field, op, value }] }` over a
whitelist of existing customer columns: `regionId`, `repId`, `category`,
`customerType`, `city`, `source`, `creditHold`, `isTaxExempt`, numeric ranges on
`totalDebt`/`creditLimit`, `createdAt` cohort, and a join to
`customer_ai_profiles` for `aiSegment`/`churnRisk`.

**Decision — materialise vs live (recommend: materialise).** Refresh dynamic
segments on three triggers: the existing `customer.changed` event (debounced), a
manual "Refresh" button, and an optional nightly job. Reads never run rule logic,
mobile can sync a flat membership list, analytics joins stay trivial. Cost:
bounded staleness between refreshes — acceptable, and the event trigger keeps it
small.

## Backend module `segments` (mirrors `offers`)

Entities + DTOs + service + controller + `AppModule` registration + one migration
`<epochMillis>-CustomerSegments.ts`.

| Endpoint | Role | Does |
|---|---|---|
| `GET /segments` | manager | List with member+rep counts, rep-scope filtered |
| `POST /segments` | admin | Create (static or dynamic) |
| `PATCH /segments/:id` | admin | Rename, recolour, edit rules, activate |
| `DELETE /segments/:id` | admin | Soft-delete |
| `GET /segments/:id/members` | manager | Paginated members (scope-filtered) |
| `POST /segments/:id/members` | admin | Add customers (ids or numbers, bulk) |
| `DELETE /segments/:id/members/:cid` | admin | Remove one |
| `POST /segments/:id/refresh` | admin | Re-materialise a dynamic segment |
| `GET /segments/:id/stats` | manager | Sales rollup |
| `POST /segments/:id/reps` | admin | Link/unlink salesmen |

- **Visibility:** every membership/stats read passes through
  `RepScopeService.visibleRepIds()`.
- **Events:** emit `segment.changed` (dashboards refresh via sync signal);
  subscribe to `customer.changed` to queue a debounced dynamic refresh.
- **Resolver:** `resolveSegmentIdsForCustomer(id)` for the offers engine — one
  indexed lookup.
- **RBAC:** read at `manager`, writes at `admin`.

## Built upon it

### A · Offer for a specific segment
- Add `segmentIds?: string[]` to `OfferEligibility`, matched as an additive AND
  constraint (like `repIds`/`regionIds`).
- Engine: in `isEligible()`, when `segmentIds` set, check the evaluated
  customer's membership (the engine already loads the customer once; add one
  membership lookup).
- UI: replace the free-text "Segments (comma-separated)" box in
  `OfferFormModal` with a real segment multi-select.
- Backfill migration: convert each `category` referenced by existing offers into
  a segment, populate membership, write `segmentIds`; legacy path stays live.
- **Decision:** keep `scopeRank()` edge for segment-scoped offers over blanket
  `ALL`; confirm ranking vs `SPECIFIC`.

### B · Sales of a segment
`GET /segments/:id/stats?from&to` over `vouchers → customers → segment_customers`,
rep-scope filtered: total sales, order count, AOV, active vs dormant members, top
items, per-rep breakdown. Money stays integer minor units (`MONEY_SCALE` /
`QUANTITY_SCALE`). Surfaces as a Stats tab + a list KPI.

### C · Linking salesmen
Two needs, both supported:
- **Ownership** — `segment_reps` records which reps serve a segment (targeting +
  reporting), without touching assignment.
- **Operational assign** — bulk "assign every customer in this segment to rep X"
  sets `customer.rep_id` across members, reusing the existing reassign path and
  its `customer.changed` signal.

## Surfaces

### Dashboard — `segments` feature
Standard layout (`api.ts` + views + route page + `endpoints.ts` +
`dictionaries.ts` + nav), RBAC-gated with `<Can>`, bilingual/RTL.
- Segments list (cards: member count, kind badge, sales KPI)
- Segment form (name, colour, static/dynamic, rule builder)
- Segment detail (Members / Reps / Stats tabs)
- Customers list: bulk "Add to segment" + filter-by-segment
- Customer profile: segment chips
- Offer form: segment multi-select

### Mobile — offline offer evaluation (the one real constraint)
The handset evaluates offers offline; if an offer targets a segment it must know
membership without a live call.

**Decision (phase 2, recommend: expand server-side).** When the device syncs
offers, the server resolves `segmentIds` → member customer numbers and bakes them
into the cached offer payload. No new synced table; correct as of last sync;
reuses the existing offer sync. Later, if segments grow large/volatile, sync a
compact `segment_customers` projection into a Room table and evaluate on-device.

## Roadmap (each phase shippable alone)

1. **The primitive** — BE + Dashboard. Three tables, `segments` module, static
   membership, dashboard feature, profile chips. Nothing consumes it yet.
2. **Offers on segments** — BE + Dashboard + Mobile. `eligibility.segmentIds`,
   engine match, offer multi-select, category backfill, offline expansion.
3. **Dynamic segments** — BE + Dashboard. `rules` engine, refresh triggers, rule
   builder UI. Static keeps working.
4. **Analytics & reps** — BE + Dashboard. Segment stats, `segment_reps`, bulk
   "assign segment → rep".

## Risks & decisions to confirm before phase 1

- **Don't ship a fourth grouping** — `customer_segments` is the managed one;
  `category` stays an attribute, AI segment an insight.
- **Membership model** — materialise (recommended) vs live.
- **Offline freshness** — server-side expansion (recommended) vs synced device
  table.
- **"Link reps" meaning** — ownership, bulk reassign, or both (plan assumes both).
- **Scope priority** — where a segment offer ranks vs `SPECIFIC`/`ALL`.
- **Performance** — index `segment_customers` both ways, paginate members,
  batch large dynamic refreshes.
