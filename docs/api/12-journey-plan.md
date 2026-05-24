# API — Journey Plan (Permanent Journey Plan / PJP)

The journey plan is the **recurring, per-outlet visit schedule** that drives daily
route generation. One entry = one outlet (customer) a rep serves + the weekdays it
should be visited. Daily routes (`/routes`) are then materialized from it.

- **Outlet** = a customer/shop.
- **weekdays** = integers `0=Sunday … 6=Saturday` (matches Postgres `EXTRACT(DOW)`).
  - *Daily* → all working days, e.g. `[0,1,2,3,4]`
  - *Weekly (Tue)* → `[2]`
  - *Twice a week (Sun+Wed)* → `[0,3]`
- A route for a date includes an outlet only if its `weekdays` contains that date's
  day-of-week and the entry is `isActive`.

All endpoints require a bearer JWT with role **admin** or **manager**.

## Shared envelopes

**Success** (every 2xx): `{ "success": true, "data": <payload>, "timestamp": "<ISO>" }`

**Error** (every non-2xx): `{ "statusCode": <int>, "message": <string|string[]>, "error": <string>, "path": <string>, "timestamp": "<ISO>" }`

Common: `400` validation / outlet not servable by this rep, `401` no token, `403`
wrong role, `404` rep / entry not found, `409` conflict, `500` server error.

---

## GET /api/v1/reps/{repId}/journey-plan

List all schedule entries for a rep.

**Response `data`** — array of:
```json
{
  "id": "uuid",
  "repId": "uuid",
  "customerId": "uuid",
  "weekdays": [0, 3],
  "isActive": true,
  "createdAt": "2026-05-23T10:00:00.000Z",
  "updatedAt": "2026-05-23T10:00:00.000Z"
}
```

---

## PUT /api/v1/reps/{repId}/journey-plan/{customerId}

Create or update one outlet's schedule (idempotent on `repId`+`customerId`).

**Request**
```json
{ "weekdays": [0, 3], "isActive": true }
```
- `weekdays` (required): 1–7 unique ints in `0..6`.
- `isActive` (optional, default `true`).

**Response `data`**: the saved entry (shape above).

**Errors**: `400` if `customerId` doesn't exist or is assigned to a different rep;
`404` if the rep doesn't exist.

---

## POST /api/v1/reps/{repId}/journey-plan/bulk

Replace the rep's **entire** journey plan in one call. Outlets not included are removed.

**Request**
```json
{
  "entries": [
    { "customerId": "uuid-A", "weekdays": [0,1,2,3,4] },
    { "customerId": "uuid-B", "weekdays": [2], "isActive": true }
  ]
}
```

**Response `data`**: the full journey plan after replacement (array of entries).

**Errors**: `400` duplicate `customerId`, or an outlet that doesn't exist / belongs
to another rep.

---

## DELETE /api/v1/reps/{repId}/journey-plan/{customerId}

Remove one outlet from the rep's journey plan. Returns **204 No Content**.

**Errors**: `404` if no entry exists for that rep+outlet.

---

## Related — generating the daily route

`POST /api/v1/routes/generate` `{ "repIds": ["uuid"], "planDate": "YYYY-MM-DD" }`
now pulls **only the outlets due on `planDate`** from each rep's journey plan,
orders them by nearest-neighbor, and writes the day's `route_plans` / `route_stops`.
If nothing is scheduled for a rep that day, no plan is created for them. See
[05-routes.md](05-routes.md) for the route lifecycle (accept / visit / skip / compliance).
