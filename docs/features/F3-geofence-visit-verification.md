# F3 — Geofenced Visit Verification (Fake-Visit Detection)

**Effort:** S–M (≈ 1.5–2 dev-days) · **Depends on:** nothing; feeds F10 notifications.

## 1. Why

Phantom visits are endemic in van sales: the rep logs a visit (or even an invoice) from the
coffee shop. Every ingredient already exists in the schema — `customers.latitude/longitude`,
`customer_visits.lat/lng`, and the live `rep_location_events` trail. One haversine check
turns them into a trust system.

## 2. Rule

A visit/voucher is **verified** when the reporting coordinates are within
`VISIT_GEOFENCE_M` (default **200 m**, configurable in `/settings`) of the customer's
stored location. Fallback chain for the "where was the rep" coordinate:

1. the lat/lng submitted with the visit (mobile already sends it), else
2. the rep's latest `rep_location_events` ping within ±5 min of the action.

If the customer has no stored coordinates → `verified = null` (unknown, excluded from
scores — and surfaced as "customer missing location" so data gets fixed).

## 3. Data model (migration)

```sql
ALTER TABLE customer_visits
  ADD COLUMN verified  boolean,           -- true/false/NULL=unknown
  ADD COLUMN distance_m real;             -- measured distance at check time
-- same two columns on voucher_headers for SALE created in the field:
ALTER TABLE voucher_headers
  ADD COLUMN geo_verified boolean,
  ADD COLUMN geo_distance_m real;
```

Settings: add `visit_geofence_m` (int, default 200) to the existing settings storage.

## 4. Backend changes

- `CustomersService.createVisit`: compute haversine (reuse the helper pattern from
  `ReportsService.repTrips`), set `verified` + `distance_m`.
- `VouchersService.create` (SALE with a `customerNumber`, caller is a rep): resolve rep's
  latest ping (≤ 5 min old) and stamp `geo_verified` / `geo_distance_m`. Never *block* on
  it v1 — measure first, enforce later (blocking with bad GPS data destroys trust in the
  system before it earns any).
- On `verified = false`: emit `visit.unverified` → F10 notification to managers
  (`"زيارة غير مؤكدة: {rep} عند {customer} — على بعد {distance} م"`).
- **New report** `GET /reports/visit-verification?days=30&repId?`:
  per rep `{ visits, verified, unverified, unknown, verifiedPct, avgDistanceM }` —
  same raw-SQL style as the rest of `ReportsService`.

## 5. Dashboard UI

- **Visits report tab**: new column "تحقق الموقع" — green ✓ (مؤكدة + distance), red ✗
  (غير مؤكدة + distance), grey — (غير معروف); filter chips for each state.
- **Reps page / rep drawer**: a "موثوقية الزيارات" stat — verified % over last 30 d with a
  tone (≥90% green, 70–90 amber, <70 red). This *is* the trust score; keep it simple.
- **Settings**: number field "نطاق التحقق من الزيارة (متر)".
- Anomaly surfacing: unverified visits also appear in the existing AI-Insights anomaly
  queue list (it's already designed to host such rows).

## 6. Mobile

No new screens. Two small touches:
- The visit/sale confirm sheet shows a quiet hint when GPS is off/poor:
  "تفعيل GPS يؤكد زيارتك تلقائيًا" (nudges compliance without policing).
- If a customer has no stored location, after a verified-by-proximity sale, offer one tap:
  "حفظ موقع العميل الحالي؟" — self-healing data.

## 7. Acceptance criteria

1. Visit at 50 m → `verified=true, distance_m≈50`. Visit at 800 m → `false` + manager
   notification within 3 s.
2. Customer without coordinates → `verified IS NULL`, excluded from `verifiedPct` math.
3. Radius change in settings affects subsequent checks only (no retro rewrite).
4. Report aggregates match hand-counted fixtures; rep filter works; unknown bucket correct.
5. No blocking behavior anywhere in v1 (vouchers always post).

## 8. Test plan

Unit: haversine + fallback-coordinate chain (visit lat → recent ping → null).
E2E: create customer w/ coords → post visit near/far → assert flags + notification row.
Data QA: backfill script intentionally **not** run on historical rows (documented).
