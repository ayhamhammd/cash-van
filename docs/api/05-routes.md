# API — Plan 05 · Route Plans & Stops

> Shared envelopes in [`docs/api/00.5-preflight.md`](./00.5-preflight.md).

Base URL: `/api/v1/`. All routes require `Authorization: Bearer <jwt>`.

A `route_plan` is one rep's plan for one day (`UNIQUE rep_id + plan_date`). It
holds ordered `route_stops`, each tied to a customer with planned/actual times
and a status. Adherence is checked passively against GPS pings (plan 02).

---

## Routes — `/api/v1/routes`

### `GET /api/v1/routes?date=&repId=`
Lists plans (each with ordered `stops`).
**Response data**: `RoutePlan[]`.

`RoutePlan`: `{ id, repId, planDate, source ('manual'|'ai_optimized'), aiEstDistance, aiEstDuration, aiSavingsMin, acceptedAt, createdAt, updatedAt, stops: RouteStop[] }`
`RouteStop`: `{ id, planId, customerId, stopOrder, estArrival, estDurationMin, actualArrival, actualDeparture, status ('pending'|'visited'|'skipped'), skipReason }`
**Errors**: `400`, `401`.

### `GET /api/v1/routes/compliance?date=YYYY-MM-DD`
Stop-completion per rep for the date.
**Response data**: `ComplianceRow[]`:
```ts
{ repId, planId, totalStops, visited, skipped, pending, completionPct }
```
**Errors**: `400`, `401`.

### `GET /api/v1/routes/:id`
One plan with ordered stops. **Errors**: `400`, `401`, `404`.

### `POST /api/v1/routes` — `@Roles('admin','manager')`
Create a manual plan.
**Body** (`CreateRoutePlanDto`):
```ts
{
  repId: uuid,
  planDate: 'YYYY-MM-DD',
  stops: [{ customerId: uuid, stopOrder?: number, estDurationMin?: number }] // 1..200
}
```
`stopOrder` defaults to array index + 1.
**Response** — `201`, `data: RoutePlan`.
**Errors**: `400` (unknown customers), `401`, `403`, `404` (rep), `409` (plan already exists for rep+date).

### `POST /api/v1/routes/generate` — `@Roles('admin','manager')`
Builds optimized plans (nearest-neighbor over each rep's located, active customers).
**Body**: `{ repIds: uuid[], planDate: 'YYYY-MM-DD' }`.
Sets `source='ai_optimized'`, computes `aiEstDistance` (km), `aiEstDuration` (min), `aiSavingsMin` vs naive order. **Replaces** any existing plan for that rep+date. Reps with no located customers are skipped.
**Response data**: `RoutePlan[]` (one per rep that had customers).
**Errors**: `400`, `401`, `403`, `404` (rep).

> The nearest-neighbor heuristic is swappable for the plan-08 AI optimizer behind this same endpoint.

### `PATCH /api/v1/routes/:id/stops/reorder` — `@Roles('admin','manager')`
**Body**: `{ order: [{ stopId, stopOrder }] }`. Every `stopId` must belong to the plan.
**Response data**: updated `RoutePlan`. **Errors**: `400` (foreign stop), `401`, `403`, `404`.

### `POST /api/v1/routes/:id/accept`
Rep accepts an AI plan → sets `acceptedAt`. **Response data**: `RoutePlan`. **Errors**: `400`, `401`, `404`.

### `POST /api/v1/routes/stops/:stopId/visit`
**Body** (`MarkVisitedDto`): `{ actualArrival?, actualDeparture? }` (ISO 8601; arrival defaults to now). Sets status `visited`.
**Response data**: `RouteStop`. **Errors**: `400`, `401`, `404`.

### `POST /api/v1/routes/stops/:stopId/skip`
**Body**: `{ reason }`. Sets status `skipped`. **Errors**: `400`, `401`, `404`.

---

## Route adherence (passive)

No public endpoint. `RouteAdherenceService` listens for the `rep.location`
event (emitted by plan 02 on every GPS ping). For the rep's plan **on the
ping's date**, if the position is farther than **500m** from *every* still-pending
stop, it emits `route.deviated` on the internal EventEmitter:

```ts
{ repId, planId, lat, lng, nearestStopMeters, recordedAt }
```

Debounced per plan: fires once when the rep goes off-route, and not again until
they return within range. Plan 10's WebSocket gateway forwards this to dashboard
clients.

---

## Swagger

All endpoints render at `/docs` under the `routes` tag.
