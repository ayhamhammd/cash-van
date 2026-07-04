# F5 — Speeding & Driver-Behavior Alerts

**Effort:** S (≈ 1 dev-day) · **Depends on:** trips report (done); F10 for notifications.

## 1. Why

The vans are the owner's second-biggest asset after stock, and the trips engine
(`ReportsService.repTrips`) **already computes per-leg speeds** — it currently *discards*
legs over 140 km/h as GPS noise and keeps `maxSpeedKmh` per trip. Surfacing a configurable
speed threshold + a weekly driving score costs almost nothing and gives the owner a safety
lever (and an insurer-friendly report).

## 2. Definitions

- **Speeding event**: ≥ 3 *consecutive* legs above `speed_limit_kmh` (default **100**,
  settings key) — consecutive-leg requirement filters single-leg GPS jitter that survives
  the 140 km/h sanity cut.
- **Driving score** (per rep per week, 0–100):
  `100 − min(60, speedingEvents × 8) − min(20, kmOver110 × 2)` — crude but monotonic;
  refine later with harsh-braking proxies (large speed deltas between adjacent legs).

## 3. Backend changes (no new tables)

- Settings: `speed_limit_kmh` int default 100.
- `repTrips()`: while walking legs, count `speedingEvents` and collect the worst window
  `{ startAt, maxKmh, nearLat, nearLng }`; add to `TripRow`:
  `speedingEvents: number; speedingMaxKmh: number | null`.
- **New report** `GET /reports/driver-behavior?days=7&repId?` → per rep:
  `{ repName, repCode, trips, distanceKm, maxSpeedKmh, speedingEvents, score }`
  (aggregates by re-running trip segmentation per day in range — acceptable at this fleet
  size; cache 5 min via the existing in-process cache if needed).
- On trip close with events > 0 (computed lazily at report time v1 — **no cron**):
  emit nothing. v1.1 option: a daily 18:00 summary notification to managers via F10
  ("اليوم: 3 تجاوزات سرعة — أعلى 124 كم/س ({rep})"). Real-time per-event alerts are
  deliberately out: noisy, and reps learn to hate the system.

## 4. Dashboard UI

- **Trips tab**: amber `Gauge` chip on rows with `speedingEvents > 0`
  ("⚠ 2 تجاوز · 118 كم/س"); summary strip gains "تجاوزات السرعة" tile.
- **Rep drawer**: "سلوك القيادة (٧ أيام)" mini-card — score ring (green ≥85 / amber 60–84 /
  red <60), top speed (mono), events count.
- **Reports hub**: small "سلوك السائقين" table (rep, km, top speed, events, score) sortable
  by score — this is the page you print for the insurer.
- Settings: number input "حد السرعة (كم/س)".
- i18n prefix `drive.*`.

## 5. Mobile

Nothing in v1 — on purpose. Showing reps their own score before the data is trusted
invites arguments; revisit after two weeks of dashboard-only observation.

## 6. Acceptance criteria

1. Trip with 3+ consecutive legs >100 km/h → `speedingEvents ≥ 1`, chip renders; a single
   fast leg → 0 events (jitter filtered).
2. Threshold change in settings reflects on next report fetch (no recompute of stored data
   needed — everything derives at query time).
3. Score formula matches fixtures; clamped to [0,100].
4. Driver-behavior report rep filter + days window correct; empty fleet → empty array.
5. No notifications fire in v1 (assert none inserted).

## 7. Test plan

Unit: event detection over synthetic leg sequences (jitter, exactly-3, boundary at limit);
score clamping. E2E: seed a fast trail via `scripts/live-track.mjs` `SPEED=130` → report
shows events. FE: chip + score card render from fixtures.
