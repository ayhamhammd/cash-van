# Plan 02 — Territories & Geography

Spec ref: Part 3.2 (adapted for single-tenant deployment)
Depends on: [01 — Auth/Reps/Settings](./01-tenants-auth-reps.md)

## Goal

Define **regions** with polygon boundaries (stored as GeoJSON; no PostGIS), and stream **rep GPS location events** for the Live Map view + route-deviation alerts.

> **Database stays vanilla Postgres** — no PostGIS. Polygons are stored as `JSONB` GeoJSON. Point-in-polygon and similar ops happen in Node via `@turf/boolean-point-in-polygon` (set up in preflight `src/common/geo/geo.util.ts`).
> **No `tenant_id`** — one deployment serves one company (see [deployment model memory](../../C:/Users/NTC/.claude/projects/c--Users-NTC-projects-cash-van-backend/memory/project_deployment_model.md)).

## Tables

### New: `regions`
```
id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
name_ar     TEXT NOT NULL,
name_en     TEXT,
boundary    JSONB,            -- GeoJSON Polygon, validated app-side by geo.util
is_active   BOOLEAN NOT NULL DEFAULT TRUE,
created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
deleted_at  TIMESTAMPTZ,
version     INTEGER NOT NULL DEFAULT 1
```

### New: `rep_location_events` (range-partitioned monthly by `recorded_at`)
```
id           BIGSERIAL,
rep_id       UUID NOT NULL REFERENCES reps(id) ON DELETE CASCADE,
lat          DOUBLE PRECISION NOT NULL,
lng          DOUBLE PRECISION NOT NULL,
accuracy_m   REAL,
recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
PRIMARY KEY (id, recorded_at)       -- partition key must be in PK
```

## Checklist

### Migration `<ts>-AddRegionsAndLocationEvents.ts`
- [ ] `CREATE TABLE regions` with check `(boundary IS NULL OR boundary->>'type' = 'Polygon')`
- [ ] Index: `idx_regions_is_active`
- [ ] `CREATE TABLE rep_location_events ... PARTITION BY RANGE (recorded_at)` with PK = `(id, recorded_at)`
- [ ] Create current-month partition + a `_default` partition catch-all
- [ ] `CREATE INDEX ON rep_location_events (rep_id, recorded_at DESC)` (created on the parent — propagates to partitions)
- [ ] `CREATE INDEX ON rep_location_events (recorded_at DESC)` for time-window scans
- [ ] Add FK `reps.region_id → regions(id) ON DELETE SET NULL`
- [ ] Add FK `users.region_id → regions(id) ON DELETE SET NULL`
- [ ] No RLS — single-tenant deployment

### Partition maintenance
- [ ] Install `@nestjs/schedule` and add `ScheduleModule.forRoot()` to AppModule
- [ ] `PartitionMaintenanceService.ensureNextMonthPartition()` — pure function that runs the `CREATE TABLE IF NOT EXISTS rep_location_events_YYYYMM PARTITION OF rep_location_events FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-MM+1-01')` SQL
- [ ] `@Cron('5 0 25 * *')` — runs at 00:05 on the 25th of every month
- [ ] Also call once on `onApplicationBootstrap()` so a freshly-deployed instance has next month covered even if today is past the 25th

### Entities
- [ ] `src/modules/regions/entities/region.entity.ts` — `boundary` typed as `GeoJsonPolygon | null`, column type `jsonb`
- [ ] `src/modules/reps/entities/rep-location-event.entity.ts`

### Modules
- [ ] `src/modules/regions/regions.module.ts` + service + controller
- [ ] Extend `src/modules/reps/reps.module.ts` with `LocationsService` + endpoints

### DTOs — Regions
- [ ] `CreateRegionDto` — `{ nameAr, nameEn?, boundary?: GeoJsonPolygon, isActive? }`
- [ ] `UpdateRegionDto` — partial
- [ ] `RegionResponseDto`

### DTOs — Locations
- [ ] `RecordLocationDto` — `{ lat, lng, accuracyM?, recordedAt? }`
- [ ] `BulkRecordLocationDto` — `{ points: RecordLocationDto[] }` (≤ 500 per request)
- [ ] `LocationEventDto` — wire shape

### Endpoints — Regions
- [ ] `GET /api/v1/regions?isActive=&q=` — list
- [ ] `GET /api/v1/regions/:id` — one (full polygon)
- [ ] `POST /api/v1/regions` — admin/manager; validates GeoJSON via `validateGeoJsonPolygon`
- [ ] `PATCH /api/v1/regions/:id` — admin/manager
- [ ] `DELETE /api/v1/regions/:id` — admin (soft)
- [ ] `GET /api/v1/regions/containing?lat=&lng=` — returns the region containing the point, or 404

### Endpoints — Rep locations
- [ ] `POST /api/v1/reps/:id/location` — single ping (mobile foreground)
- [ ] `POST /api/v1/reps/:id/location/bulk` — batched (offline-flush, ≤ 500 points)
- [ ] `GET /api/v1/reps/:id/locations?from=&to=&limit=` — replay (default last 24h)
- [ ] `GET /api/v1/reps/locations/latest` — last ping per active rep (powers Live Map)
- [ ] `GET /api/v1/reps/:id/locations.geojson?from=&to=` — GeoJSON LineString export

### Live Map support
- [ ] `LatestRepLocationDto` — `{ repId, nameAr, lat, lng, accuracyM, recordedAt, status: 'online'|'idle'|'offline' }`
- [ ] Status helper: `online` (≤ 5 min), `idle` (≤ 30 min), `offline` (> 2 h or no ping today)
- [ ] On every successful POST `/location` and `/location/bulk`, emit `rep.location` on the internal `EventEmitter2` (plan 10 will subscribe and forward over WebSocket)

### Region-membership helper
- [ ] `RegionsService.findRegionContaining(lat, lng): Region | null` — iterates active regions and uses `geo.util.isPointInPolygon`. Used later by customer create/update (plan 03) and route-adherence (plan 05). Acceptable for ≤ a few hundred regions; revisit if it grows.

### Acceptance
- [ ] Migration up/down clean on fresh DB
- [ ] Upload a region GeoJSON polygon → fetch back identical
- [ ] POST 100 location events for 2 reps → `GET /reps/locations/latest` returns 2 rows, latest ping per rep, correct status
- [ ] Replay `GET /reps/:id/locations` returns points in time order
- [ ] Partition strategy: `\d+ rep_location_events` in psql shows current-month partition exists; force-run the cron and verify next-month partition appears
- [ ] `GET /regions/containing?lat=&lng=` returns correct region for a point inside, 404 for a point outside
- [ ] DELETE region → `reps.region_id` becomes NULL for reps in that region (FK ON DELETE SET NULL)
- [ ] `docs/api/02-territories-geography.md` + `docs/test-plans/02-territories-geography.md` written
