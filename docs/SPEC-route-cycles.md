# SPEC — Flexible route cycles (1–100 days)

A rep's journey plan repeats over a cycle of **any length from 1 to 100 days**, not a fixed
7-day week. Days are numbered **1..N**. The cycle is **date-driven** and **restarts
automatically**: the day is derived from the calendar, and when the last day passes the plan
rolls straight back to day 1 with nothing to press.

Extends `docs/SPEC-*` route/journey-plan behaviour. Supersedes the weekday model
(`journey_plan_entries.weekdays`, 0=Sun..6=Sat), which shipped before this.

---

## 1. What already exists (verified 2026-08-19, live on both clients)

The cycle mechanism is **built and deployed**. Confirmed on 94.142.51.91 and 77.245.5.113:
`GET /api/v1/my-route/cycle` and `GET|PUT /api/v1/reps/:repId/journey-plan/cycle` all answer.

- `reps.route_cycle_days` (smallint, default 7), `reps.route_cycle_anchor` (date, default
  `2024-01-07` — a Sunday), `reps.route_cycle_name` (text, nullable).
- `journey_plan_entries.cycle_days` (smallint[]) — day indices, **0-based internally**,
  rendered 1-based in every UI.
- The recurrence rule lives in exactly one place, `JourneyPlanService.dueCustomerIds()`:

      cycleIndex = ((date − anchor) mod N + N) mod N

  Route planning, adherence, the dashboard and the mobile "today" view all resolve through it.
- **Auto-restart is inherent to the modulo** — no state, no scheduled job, no end-of-cycle
  event. Day N is followed by day 1 because that is what `mod N` does.
- **Backward compatibility is proven, not assumed.** With N=7 and a Sunday anchor,
  `cycleIndex` is identically `EXTRACT(DOW)`. Verified in SQL across every date from
  2023-01-01 to 2027-12-31: **1,826 days, zero divergence**, including dates before the
  anchor where a single modulo returns a negative remainder.

**Current hard limit: 60 days.** Enforced in four places (§3.1).

## 2. What this spec changes

| | today | after |
|---|---|---|
| Max cycle length | 60 | **100** |
| Day numbering | 1..N in UI, 0-based in API | unchanged |
| Advance | by calendar date | unchanged |
| Restart | automatic, via modulo | unchanged |
| Web day selector | horizontal tab strip | **grid above 14 days** |
| Mobile day picker | **does not exist** | new screen affordance |

The semantics are already correct. The work is the cap, and making a 100-day cycle
*usable* — a 100-item horizontal strip is roughly 12,000px of scrolling, so finding day 63
is impossible in the current UI. That, not the recurrence maths, is the real task.

---

## 3. Backend

### 3.1 Raise the cap (four places, all currently `60`)

| file | line | change |
|---|---|---|
| `src/database/migrations/…-RouteCycle.ts` | 52 | `chk_reps_route_cycle_days` → `BETWEEN 1 AND 100` |
| same | 84, 86 | `ck_journey_plan_cycle_days` → length `1..100`, values `< 100` |
| `src/modules/routes/dto/journey-plan.dto.ts` | 34, 51 | `@ArrayMaxSize(100)` |
| same | 108, 114 | `maximum: 100`, `@Max(100)` |

The two DB constraints are **not** editable in place — a new migration must drop and re-add
them. Widening a CHECK is always safe (every existing row already satisfies the narrower
rule), so no data validation pass is needed.

    ALTER TABLE reps DROP CONSTRAINT IF EXISTS chk_reps_route_cycle_days;
    ALTER TABLE reps ADD CONSTRAINT chk_reps_route_cycle_days
      CHECK (route_cycle_days BETWEEN 1 AND 100);

    ALTER TABLE journey_plan_entries DROP CONSTRAINT IF EXISTS ck_journey_plan_cycle_days;
    ALTER TABLE journey_plan_entries ADD CONSTRAINT ck_journey_plan_cycle_days
      CHECK (array_length(cycle_days,1) BETWEEN 1 AND 100
             AND 0 <= ALL(cycle_days) AND 100 > ALL(cycle_days));

Per-rep validation (`validDays()`) already bounds day indices to that rep's own N, so a
14-day rep still cannot be given day 40. The DB constraint is only the outer envelope.

### 3.2 Nothing else changes

- `smallint` holds 100 comfortably (max 32,767).
- `carryForwardLookbackDays` is `max(30, N × 2)` → 200 days at N=100. Already correct;
  a fixed 30 would have dropped misses from the previous cycle at this length.
- `cycleIndexOf()` needs no change — the modulo is length-agnostic.

### 3.3 Endpoints (already shipped, listed for the FE/mobile teams)

    GET  /api/v1/reps/:repId/journey-plan/cycle    → { cycleDays, anchorDate, name, todayIndex }
    PUT  /api/v1/reps/:repId/journey-plan/cycle    ← { cycleDays?, anchorDate?, name?, force? }
    GET  /api/v1/reps/:repId/journey-plan/day?day= → outlets for a cycle day
    GET  /api/v1/my-route/cycle                    → the signed-in rep's own cycle
    GET  /api/v1/my-route/today                    → resolved server-side, no day param
    GET  /api/v1/my-route/day?day=                 → `weekday=` still accepted (deprecated)

**Shrinking refuses by default.** Reducing N strands outlets scheduled past the new last day;
`PUT` returns 400 with `code: ROUTE_CYCLE_WOULD_STRAND_OUTLETS` unless `force: true`, which
drops only the out-of-range days and deletes an entry only when it has none left. A visit that
quietly stops happening is not noticed for weeks — hence the refusal rather than a silent trim.

---

## 4. Web dashboard

### 4.1 The day selector must change shape above ~14 days

`WeeklyRouteView.tsx` renders `Array.from({length: cycle.cycleDays})` as a horizontally
scrolling strip. That is right for 7 and tolerable for 14. At 100 it is unusable.

**Rule: ≤ 14 days keeps the strip; above that, switch to a grid.**

- Grid of **7 columns**, so every row is a week and the common 14/21/28-day cycles line up
  exactly. A 100-day cycle is 15 rows — one screen, no horizontal scrolling. (7 was chosen
  over 10: a 10-wide grid would need separators every 7 cells to read as weeks, and those
  land diagonally.)
- Each cell: day number and the outlet count badge. The cells are too small for a date, so
  the **selected day spells itself out in a caption below the grid** — "Day 63" alone means
  nothing — and each cell carries the full label and date as a `title`.
- Today's cell keeps its accent border; the selected cell keeps the filled accent.
- A **"jump to day"** number input beside the cycle badge, because scanning 15 rows for day
  63 is still slower than typing it. Hidden on short cycles.

Keep `overflow-x-auto` on the strip branch; the grid never scrolls horizontally.

The selected day must default to `cycle.todayIndex`, **not** `new Date().getDay()` — the
latter is only meaningful on a 7-day cycle and would open a 100-day plan on day 5 while
today is day 57.

### 4.2 Entry editor

The day toggles already `flex-wrap`, so 100 compact numbered buttons wrap without code
changes. Two additions worth making at that size:

- **Select all / clear** — setting an outlet to "every day" of a 100-day cycle is otherwise
  100 clicks.
- **"every Nth day" helper** — the common real pattern (visit every 14 days within a 100-day
  cycle) is otherwise hand-picked.

### 4.3 Cycle editor

`max={60}` → `max={100}` and the `valid` check `parsed <= 60` → `<= 100`
(`WeeklyRouteView.tsx:596, 643`). The stranded-outlet warning already computes locally from
the loaded plan and needs no change.

---

## 5. Mobile (FlowVan)

### 5.1 Nothing breaks today

`MyRouteApi.today()` sends no day parameter — the server resolves the cycle — so **handsets
already in the field work on a 100-day cycle without being updated**. `MyRouteStopDto.days`
reads `cycleDays` or falls back to `weekdays`, so one build works against an old or new server.

### 5.2 What to add

There is currently **no day picker on the handset**: `MyRouteApi.day()` exists but nothing
calls it, and no screen displays weekday names. To let a rep look ahead:

- Call `GET /my-route/cycle` on the route screen to get `cycleDays`, `anchorDate`,
  `todayIndex`, `name`.
- Header shows the cycle name (or "N days") and **"Day {todayIndex+1} of {cycleDays}"** —
  the single most useful line for a rep on a long cycle, who otherwise has no idea where
  they are in it.
- Day picker: a horizontal pager for short cycles; for long ones, a compact grid sheet
  matching the dashboard, defaulting to today.
- Each day shows its real date. On a 100-day cycle "day 63" alone is meaningless.

Call `day(dayIndex)` — it sends `day=`, not `weekday=`.

---

## 6. Edge cases

- **Anchor changes shift every outlet.** Moving `anchorDate` by one day moves the whole plan
  by one day. It is a setup-time field; the UI must not present it as casually editable.
- **N=1** is legal: every active outlet is due every day.
- **Long cycles and adherence.** At N=100 an outlet on day 63 is due roughly three times a
  year. "Overdue" reporting must read the cycle length, not assume a week — the lookback
  already scales, but any new report must too.
- **Timezone.** All cycle maths runs on `YYYY-MM-DD` strings via `Date.UTC`, deliberately not
  local `Date` parsing, so the server's timezone cannot decide which day an outlet is due and
  a rep near midnight sees the same route the office does.

## 7. Out of scope

- **Completion-driven advance.** Considered and rejected for this revision: the plan follows
  the calendar, so a missed day is missed rather than pushing the whole cycle back. Revisit
  only with the carry-forward list, which already surfaces missed outlets.
- **Shared/numbered plan templates** across reps. The cycle stays per-salesman.
- **Per-round history.** No record is kept of "which pass of the cycle" a visit belonged to.
