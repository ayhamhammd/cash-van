# API — Plan 02 · Territories & Geography

> Shared envelopes (success + error) are documented in [`docs/api/00.5-preflight.md`](./00.5-preflight.md).

Base URL: `/api/v1/`. All routes require `Authorization: Bearer <jwt>`.

---

## Regions — `/api/v1/regions`

A region is an Arabic/English-named territory defined by a GeoJSON polygon. Polygons are validated app-side (no PostGIS). All `boundary` values must be GeoJSON `Polygon` with closed rings.

### `GET /api/v1/regions`

**Query**
| Param | Type | Notes |
|---|---|---|
| `isActive` | boolean | optional |
| `q` | string | substring on `nameAr / nameEn` |
| `limit` | int | 1–200, default 50 |
| `offset` | int | ≥ 0, default 0 |

**Response data**: `{ items: Region[], total: number }`

`Region`:
```ts
{
  id: string;
  nameAr: string;
  nameEn: string | null;
  boundary: GeoJSON.Polygon | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
}
```

**Possible errors**: `400 BadRequestException` (bad query), `401 UnauthorizedException`.

### `GET /api/v1/regions/containing?lat=<>&lng=<>`

Returns the first **active** region whose polygon contains the point. Used by mobile / customer-create to auto-assign a region.

**Response data**: `Region`
**Possible errors**: `400` (non-numeric lat/lng), `401`, `404 NotFoundException` (no region contains the point).

```bash
curl "http://localhost:3000/api/v1/regions/containing?lat=32.0&lng=35.9" \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /api/v1/regions/:id`
**Response data**: `Region`
**Possible errors**: `400`, `401`, `404`.

### `POST /api/v1/regions` — `@Roles('admin','manager')`

**Request body** (`CreateRegionDto`)
```ts
{
  nameAr: string;
  nameEn?: string;
  boundary?: GeoJSON.Polygon;   // must be valid GeoJSON with closed rings
  isActive?: boolean;           // default true
}
```

**Response** — `201 Created`, `data: Region`.
**Possible errors**: `400` (invalid GeoJSON, e.g. unclosed ring or out-of-WGS84-range), `401`, `403 ForbiddenException`.

```bash
curl -X POST http://localhost:3000/api/v1/regions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "nameAr":"شمال عمان","nameEn":"North Amman",
    "boundary":{"type":"Polygon","coordinates":[[
      [35.85,31.95],[35.95,31.95],[35.95,32.05],[35.85,32.05],[35.85,31.95]
    ]]}
  }'
```

### `PATCH /api/v1/regions/:id` — `@Roles('admin','manager')`
Partial. Pass a new `boundary` to replace it; pass `null`/omit to leave it.
**Possible errors**: `400`, `401`, `403`, `404`.

### `DELETE /api/v1/regions/:id` — `@Roles('admin')`
Soft-deletes. Reps and users in this region have their `region_id` set to NULL (FK `ON DELETE SET NULL`).
**Response** — `204 No Content`.
**Possible errors**: `400`, `401`, `403`, `404`.

---

## Rep GPS — `/api/v1/reps/...`

Backed by `rep_location_events`, monthly-partitioned by `recorded_at`. Old months can be dropped cheaply; next month's partition is auto-created by the `PartitionMaintenanceService` cron (00:05 on the 25th) and on every app boot.

### `POST /api/v1/reps/:id/location` — single ping

**Request body**
```ts
{
  lat: number;            // -90..90
  lng: number;            // -180..180
  accuracyM?: number;     // >= 0
  recordedAt?: string;    // ISO 8601; defaults to server now()
}
```

**Response** — `201 Created`, `data:`
```ts
{
  id: string;             // bigint as string
  repId: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: string;
}
```

Side effect: emits `rep.location` on the internal EventEmitter (consumed by plan 10's WebSocket gateway when it ships).

**Possible errors**: `400` (bad payload), `401`, `404 NotFoundException` (rep missing).

### `POST /api/v1/reps/:id/location/bulk` — offline-flush

**Request body**
```ts
{
  points: RecordLocationDto[];    // 1..500 entries
}
```

**Response data**: `{ accepted: number }` (echoes `points.length`).
Emits one `rep.location` event for the latest point in the batch.

**Possible errors**: `400` (>500 points, invalid coords), `401`, `404`.

### `GET /api/v1/reps/locations/latest`

Latest ping per **active** rep within the last 24h. Powers the dashboard's Live Map.

**Response data**: `LatestRepLocation[]`

```ts
{
  repId: string;
  nameAr: string;
  nameEn: string | null;
  lat: number;
  lng: number;
  accuracyM: number | null;
  recordedAt: string;
  status: 'online' | 'idle' | 'offline';
}
```

Status windows:
- `online`: last ping ≤ 5 min ago
- `idle`: 5–30 min ago
- `offline`: > 30 min ago (or no ping in last 24h → not returned)

**Possible errors**: `401`, `500 QueryFailedError` (DB unreachable).

### `GET /api/v1/reps/:id/locations`

**Query**
| Param | Type | Default |
|---|---|---|
| `from` | ISO 8601 | now − 24h |
| `to` | ISO 8601 | now |
| `limit` | int | 1000 (max 10000) |

**Response data**: `RepLocationEvent[]` ordered by `recordedAt ASC`.

**Possible errors**: `400` (bad date), `401`, `404`.

### `GET /api/v1/reps/:id/locations.geojson`

Same query params. Returns a GeoJSON `FeatureCollection` with a single `LineString` feature, ready to drop into Leaflet/Mapbox.

```ts
{
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[lng, lat], ...] },
    properties: { repId, from, to, pointCount }
  }]
}
```

**Possible errors**: `400`, `401`, `404`.

---

## Partition maintenance

No public endpoint. The `PartitionMaintenanceService`:
- On every app boot, ensures next month's `rep_location_events_YYYYMM` partition exists (idempotent `CREATE TABLE IF NOT EXISTS`).
- Runs `@Cron('5 0 25 * *')` on the 25th of every month at 00:05.

Inspect partitions from psql:

```sql
SELECT inhrelid::regclass AS partition
FROM pg_inherits
WHERE inhparent = 'rep_location_events'::regclass
ORDER BY 1;
```

---

## Swagger

All endpoints render at `/docs` with Bearer auth, request/response shapes, and the GeoJSON example body for region creation.
