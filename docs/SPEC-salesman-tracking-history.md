# SPEC — Salesman Tracking History (map + per-month, date-range playback)

Give managers a **historical** view of where each salesman went: pick a salesman and a
period (a **day**, a **month**, or a **from→to** range) and see their **GPS trail on a
map** with **customer-visit markers**, plus **per-day / per-month summaries** (distance,
active hours, customers visited, sales). Also a **per-customer** angle: every visit a
customer received (which rep, when, whether it converted to a sale).

Status: **proposal**. Extends the existing **live** tracking (`/livemap`) into history.
Money is **fils** on the dashboard side. Complements
[end-of-day report](SPEC-end-of-day-report.md) and the reps/locations module.

---

## 1. Goal / user stories

- A manager opens **Tracking History**, picks salesman *Jehad* and **July 2026** → sees a
  map with his movement trail for the month and a marker at every customer he visited.
- They switch the range to **a single day** → the map shows just that day's route,
  ordered oldest→newest, with visit times.
- They switch to **from 2026-07-01 to 2026-07-10** → the trail spans those days.
- A side panel shows **per-day rows** (date · distance · active hours · #customers ·
  #sales) they can click to zoom the map to that day.
- From a **customer's** page, they see that customer's **visit history**: each visit's
  date, the rep, had-sale, and note — across any month.

---

## 2. What already exists (reuse — do NOT rebuild)

| Piece | Where | Notes |
|---|---|---|
| `rep_location_events` table | `reps/entities/rep-location-event.entity.ts` | `id bigint, rep_id uuid, lat double, lng double, accuracy_m real, recorded_at timestamptz`. **Monthly-partitioned** (`PartitionMaintenanceService`), indexed `(rep_id, recorded_at desc)`. |
| Trail endpoint | `GET /reps/:id/locations?from=&to=&limit=` (`locations.controller.ts`) | **Already accepts an arbitrary `from`/`to` ISO range** + `limit` (≤10000). Today's-trail is just `from = midnight`. History = pass any range. |
| Visits table | `customer_visits` (`customers/entities/customer-visit.entity.ts`) | `customer_id, rep_id, visited_at, had_sale, visit_note, lat, lng`. Indexed `(rep_id, visited_at)` and `(customer_id, visited_at)`. |
| Mobile capture | `LocationTrackingCoordinator` + `/reps/:id/location(/bulk)` | The van already samples GPS and bulk-syncs it; visits are recorded on customer actions. **No mobile change needed.** |
| Live map UI | FE `features/livemap/` (`GoogleMapCanvas`, `LiveMapView`, `useRepTrail`) | Google Maps (`@vis.gl/react-google-maps`) already renders a rep's trail polyline. The history page reuses the canvas. |

> The heavy lifting (capture, storage, partitioning, a range-capable trail endpoint, a map
> canvas) is **done**. This feature is mostly a **new dashboard page + 2 read endpoints +
> summaries**.

---

## 3. Gaps to build

### 3.1 Backend (dash-api)

Small additions to the reps + customers modules.

**A. Visits over a range (for the map's visit markers + the per-customer view)**
- `GET /reps/:id/visits?from=&to=` → the rep's `customer_visits` in the range:
  `[{ customerId, customerNumber, customerName, visitedAt, hadSale, note, lat, lng }]`.
- `GET /customers/:customerNumber/visits?from=&to=` → that customer's visits:
  `[{ repId, repName, visitedAt, hadSale, note }]` (per-customer angle).

**B. Per-day / per-month tracking summary** (drives the side panel + month rollup)
- `GET /reps/:id/tracking-summary?from=&to=&bucket=day|month` →
  per bucket: `{ date, points, distanceKm, firstAt, lastAt, activeMinutes, customersVisited, sales }`.
  - `distanceKm` = sum of haversine between consecutive `rep_location_events` in the bucket.
  - `activeMinutes` = span first→last ping (or sum of gaps under an idle threshold).
  - `customersVisited` / `sales` = from `customer_visits` (sales = `had_sale`).
- Compute in SQL where possible; distance needs consecutive-row math (window `LAG`).

**C. Trail downsampling (performance — a month can be 20k–40k pings)**
- Extend the trail endpoint with an optional `maxPoints` (or `everyNth`) so a month
  request returns a **simplified** path, not 40k rows. Options (pick per Phase 1):
  - cheap: server-side `everyNth = ceil(total / maxPoints)` stride, OR
  - better: time-bucket (one point per N seconds), OR
  - best: Douglas–Peucker line simplification (keeps shape, drops redundant points).
- Keep the `≤10000` hard cap; the FE requests `maxPoints ≈ 2000` for a month view.

### 3.2 Frontend (dashboard)

**New page `/tracking` (nav under Insights/Operations, `manager+`):**
- **Filters**: salesman picker (reuse `useReps`); period control with modes
  **Day** (date), **Month** (year-month), **Range** (from→to). Translate the mode to
  `from`/`to` ISO for the queries.
- **Map** (reuse `GoogleMapCanvas`): draw the trail **polyline** (oldest→newest, arrow/
  gradient for direction); **visit markers** from `/reps/:id/visits` (green = had sale,
  grey = no sale; popup shows customer, time, note); start/end pins. Fit bounds to the
  data.
- **Side panel — per-day list** from `tracking-summary?bucket=day`: rows of
  date · distance · hours · #customers · #sales; click → filter map to that day.
- **Summary strip**: total distance, active hours, customers visited, sales, days active.
- **Playback (optional, Phase 2)**: a scrubber that animates a moving marker along the
  trail by `recordedAt`.
- **CSV export** of the per-day summary.

**Per-customer visits** (customer detail page): a "Visit history" section listing
`/customers/:number/visits` (rep, date, had-sale, note), with a month filter.

Everything bilingual (ar+en) via the flat `t()` dictionary; money in fils → `formatJOD`.

---

## 4. Data flow

```
 Van (already): GPS sampling ─┬─▶ POST /reps/:id/location(/bulk) ─▶ rep_location_events (monthly parts)
                              └─▶ customer action ─────────────▶ customer_visits

 Dashboard (new): Tracking History page
   rep + range ─▶ GET /reps/:id/locations?from&to&maxPoints ─▶ trail polyline
              ─▶ GET /reps/:id/visits?from&to ───────────────▶ visit markers
              ─▶ GET /reps/:id/tracking-summary?bucket ──────▶ per-day panel + totals
   customer   ─▶ GET /customers/:number/visits?from&to ──────▶ per-customer visit history
```

No ERP involvement — this is purely VanFlow location data.

---

## 5. Performance & correctness notes

- **Partition-aware**: `rep_location_events` is monthly-partitioned; range queries that
  cross a month boundary hit multiple partitions — fine, but keep `from/to` bounded
  (reject ranges > e.g. 92 days, or force downsampling). Ensure future partitions exist
  (`PartitionMaintenanceService` already does).
- **Downsample before it hits the browser** — never ship 40k points to the map; cap at
  ~2k (§3.1C). Distance/summary must be computed on the **full** rows server-side, not the
  downsampled set.
- **Ordering**: trail oldest→newest (matches the existing endpoint) so the polyline draws
  correctly.
- **Timezone**: bucket by the org's local day, not UTC, or day boundaries look wrong.
- **Privacy/retention**: location history is sensitive; note any retention window and
  gate the page to `manager+` (RBAC). Consider a retention job (drop partitions older than
  N months) as a follow-up.

---

## 6. Phased plan

**Phase 1 — Backend reads**
- [ ] `GET /reps/:id/visits`, `GET /customers/:number/visits` (range)
- [ ] `GET /reps/:id/tracking-summary?bucket=day|month` (distance via `LAG`, active mins, visits/sales)
- [ ] trail endpoint `maxPoints`/downsampling
- ✅ *Accept:* a month range returns ≤ maxPoints trail points + correct per-day distances/visits.

**Phase 2 — Frontend page**
- [ ] `/tracking` page: rep picker + Day/Month/Range control
- [ ] map trail polyline + visit markers + start/end + fit-bounds (reuse `GoogleMapCanvas`)
- [ ] per-day summary panel + totals strip + CSV
- [ ] nav entry + i18n (ar+en)
- ✅ *Accept:* pick rep + month → trail + visits render; clicking a day zooms to it.

**Phase 3 — Polish**
- [ ] customer detail "Visit history" section
- [ ] trail playback scrubber (animated marker)
- [ ] (optional) location retention job

---

## 7. Open questions

1. **Range cap** — max span for one query (protects the DB): 31 days? 92 days? Beyond
   that, force month-bucketed summary only (no full trail).
2. **Downsampling method** — stride vs time-bucket vs Douglas–Peucker for the month trail
   (§3.1C). Start with stride, upgrade if the shape looks bad.
3. **Map provider** — the live map uses Google Maps (`@vis.gl/react-google-maps`, needs
   `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`); `react-leaflet` is also available (no key). Which for
   the history page? (Reusing `GoogleMapCanvas` = Google.)
4. **"Per customer per month"** — is the primary customer view *a customer's visit list*
   (who came, when) or *a heatmap of which customers a rep covered*? The spec assumes the
   former; confirm.
5. **Retention** — how long is GPS history kept? (Drives a partition-drop job + privacy.)
