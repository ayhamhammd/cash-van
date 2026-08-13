# PLAN — Sale location on the salesman track

**Goal:** when a salesman saves a voucher, keep the GPS fix taken at that moment
and draw it as a point on that rep's tracking map.

**Repos:** `cash-van-dashboard` (backend), `cash-van-dashboard-frontend`
**Mobile app:** no change needed — see §2.

---

## 1. Why this is small

Most of it already exists. `CreateVoucherDto` already carries `repLat`/`repLng`,
and the app already sends them on every voucher: they feed the proximity
geofence (`customers.requireProximity`) and seed a missing customer location.

Today they are **used and thrown away**. Nothing persists them, so the sale's
location is gone the moment the request ends.

The tracking map already renders two layers — a GPS trail (`rep_location_events`)
and visit markers (`customer_visits`). This adds a third: sale points.

Evidence the gap is real, from the client's live dashboard: **0 visits today
against 24 posted vouchers**. `customer_visits` is only ever written by the
explicit "add visit" action, so a day of selling leaves no map trace at all.

## 2. Mobile app

No change. The app already sends `repLat`/`repLng` on create, and the sync inbox
spreads the whole stored payload into the DTO (`promoteVoucher`), so offline
vouchers carry their coordinates through to promotion unchanged.

One consequence worth stating: the fix is taken **when the voucher is saved on
the device**, not when it reaches the server. For an offline sale promoted hours
later that is the correct location but a stale timestamp — so the point is
plotted at the voucher's own `in_date`, never at promotion time.

## 3. Data model

Three nullable columns on `voucher_headers`:

```sql
ALTER TABLE voucher_headers
  ADD COLUMN sale_lat        double precision,
  ADD COLUMN sale_lng        double precision,
  ADD COLUMN sale_accuracy_m real;
```

Nullable is not laziness — it is the honest shape:

- every historical voucher has no fix and never will
- a rep indoors, or with location off, legitimately saves without one
- a dashboard-created voucher has no rep position at all

A partial index for the map query, which only ever wants rows that have a fix:

```sql
CREATE INDEX idx_voucher_headers_sale_point
  ON voucher_headers (user_code, in_date)
  WHERE sale_lat IS NOT NULL;
```

**Why on the voucher and not as a `rep_location_event`:** an event is an
anonymous breadcrumb. Writing sales in there would make them indistinguishable
from ordinary pings, break the trail's distance maths by injecting duplicate
points, and lose the link back to the sale. The voucher owns its own location.

## 4. Backend

1. **Persist** — `VouchersService.create()` writes `dto.repLat`/`repLng` onto the
   header. Coordinates are validated by the DTO already (`@Min(-90)/@Max(90)`,
   `@Min(-180)/@Max(180)`); a partial pair (lat without lng) is stored as
   neither, since half a coordinate is not a location.

2. **Read** — `LocationsService.salePointsForRep(repId, from, to)`, next to
   `visitsForRep` so the map's three sources sit together. Returns
   `{ voucherNumber, transKind, total, customerNumber, customerName, lat, lng, at }`.

   Joins `voucher_headers` to `reps` through `users.user_number = user_code` —
   the same link the targets report uses.

3. **Route** — `GET /api/v1/reps/:id/sale-points?from&to`, beside the existing
   `/locations` and `/visits`.

## 5. Frontend

- `useRepSalePoints(repId, from, to)` in `features/tracking/api.ts`, mirroring
  `useRepVisits`.
- A third marker layer in `TrackingMapCanvas`, visually distinct from visit
  markers (sales are money, visits are presence).
- Popup shows voucher number, customer and total, so a point is traceable back
  to the sale it came from.

## 6. Sequence

1. Migration + entity columns + persist on create. *(No visible change yet —
   coordinates simply stop being discarded.)*
2. Query + endpoint.
3. Frontend layer.

Step 1 is safe on its own and starts capturing data immediately, which matters:
points can only ever be drawn for vouchers created **after** it ships. Nothing
backfills history.

## 7. Deliberately out of scope

- **Backfill.** Impossible — the data was never stored.
- **Auto-creating a `customer_visit` from a sale.** It would fix the "0 visits,
  24 sales" oddity, but visits are a separate concept with their own explicit
  action, and conflating them would double-count the days reps do both. Worth
  deciding separately.
- **Distance/route analytics over sale points.** The trail already owns distance.
