# Plan 05 — Route Plans & Stops

Spec ref: Part 3.5 (adapted for single-tenant deployment)
Depends on: [01 — Reps](./01-tenants-auth-reps.md), [02 — Territories/GPS](./02-territories-geography.md), [03 — Customers](./03-customers.md)

## Goal

Daily route planning per rep — supports manual ordering, heuristic optimization, and adherence tracking against actual GPS.

> **No `tenant_id` / no RLS** (single-tenant).
> **`/routes/generate`** uses a real nearest-neighbor heuristic over customer coordinates now (haversine). When plan 08's AI optimizer ships, the call can be swapped behind the same endpoint — no dead stub.
> **Adherence** listens to the `rep.location` event emitted by plan 02 and emits `route.deviated` on the internal EventEmitter (plan 10 forwards it over WebSocket).
> Tables here do NOT extend `BaseEntity` — explicit columns only (no `version`).

## Tables

### `route_plans`
```
id UUID PK, rep_id UUID FK→reps, tenant_id UUID, plan_date DATE,
source TEXT DEFAULT 'manual',          -- manual | ai_optimized
ai_est_distance REAL, ai_est_duration INT, ai_savings_min INT,
accepted_at TIMESTAMPTZ, created_at TIMESTAMPTZ,
UNIQUE (rep_id, plan_date)
```

### `route_stops`
```
id BIGSERIAL PK, plan_id UUID FK→route_plans, customer_id UUID FK→customers,
stop_order INT, est_arrival TIMESTAMPTZ, est_duration_min INT DEFAULT 20,
actual_arrival TIMESTAMPTZ, actual_departure TIMESTAMPTZ,
status TEXT DEFAULT 'pending',         -- pending | visited | skipped
skip_reason TEXT
```

## Checklist

### Migration
- [ ] `<ts>-AddRoutePlansAndStops.ts`
- [ ] `CREATE TABLE route_plans` + check constraint on `source IN ('manual','ai_optimized')`
- [ ] Indexes: `(tenant_id, plan_date)`, `(rep_id, plan_date DESC)`
- [ ] `CREATE TABLE route_stops` + check on `status IN ('pending','visited','skipped')`
- [ ] Indexes: `(plan_id, stop_order)`, `(customer_id, status)`
- [ ] Enable RLS on both tables

### Entities
- [ ] `src/modules/routes/entities/route-plan.entity.ts` (OneToMany → stops)
- [ ] `src/modules/routes/entities/route-stop.entity.ts`

### Module
- [ ] `src/modules/routes/routes.module.ts` + service + controller

### Services
- [ ] `RoutesService`
  - [ ] `findByRepAndDate(repId, date)` returns plan + ordered stops
  - [ ] `createPlan(repId, date, source, stops[])`
  - [ ] `reorderStops(planId, [{stop_id, stop_order}])`
  - [ ] `markStopVisited(stopId, { actualArrival, actualDeparture })`
  - [ ] `markStopSkipped(stopId, reason)`
  - [ ] `complianceForDate(date)` — % visited per rep
- [ ] `RouteAdherenceService`
  - [ ] Cross-references `rep_location_events` with planned stops to detect deviations (radius > X meters from any stop = deviation)
  - [ ] Emits `route.deviated` event when threshold breached (publishes to internal EventEmitter; WebSocket delivery in plan 10)

### DTOs
- [ ] `CreateRoutePlanDto` — `{ rep_id, plan_date, stops: [{customer_id, stop_order, est_duration_min?}] }`
- [ ] `ReorderStopsDto`
- [ ] `MarkVisitedDto`, `MarkSkippedDto`
- [ ] `RouteComplianceReportDto`

### Endpoints
- [ ] `GET /api/v1/routes?date=&rep_id=` — list route plans
- [ ] `GET /api/v1/routes/:id`
- [ ] `POST /api/v1/routes` — manual create
- [ ] `PATCH /api/v1/routes/:id/stops/reorder`
- [ ] `POST /api/v1/routes/stops/:stopId/visit`
- [ ] `POST /api/v1/routes/stops/:stopId/skip`
- [ ] `GET /api/v1/routes/compliance?date=` — % stops visited per rep
- [ ] `POST /api/v1/routes/generate` — body: `{ rep_ids: [], date }` → enqueue AI-optimize job; calls `/api/v1/ai/route-optimize` (implemented in plan 08), stores result, sets `source='ai_optimized'`
- [ ] `POST /api/v1/routes/:id/accept` — rep accepts AI plan (sets `accepted_at`)

### Acceptance
- [ ] Create manual plan with 5 customers, reorder, mark some visited/skipped
- [ ] `GET /routes/compliance?date=today` returns correct %
- [ ] Deviation detection: simulate GPS event 500m from any planned stop → `route.deviated` event fires on EventEmitter
- [ ] Migration up/down clean
