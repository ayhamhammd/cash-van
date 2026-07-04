# F12 — Salesman GPS Tracking (KMP mobile)

**Repos:** `FlowVan` (AndroidStudioProjects/FlowVan, main work) + `cash-van-dashboard` (backend — already live, no changes).
**Effort:** M (≈ 2–3 dev-days). **Status:** spec ready.
**Written for an implementing agent** — package paths, DTOs, and acceptance criteria are exact.
**Platform:** Kotlin Multiplatform Compose, offline-first. Android first; iOS via `expect/actual` for the GPS provider only.

## 1. Goal

The FlowVan salesman app must continuously capture the device's GPS position while the rep is
on shift and stream it to the backend so the office dashboard live map (`/reps/locations/latest`)
and the `rep.location` WebSocket event show the rep moving in near-real-time.

It must work **offline-first**: pings are written to a local queue first, then flushed to the
server in batches. Nothing is lost when the network drops in the field.

```
GPS provider ──► LocationQueue (SQLDelight) ──► Sync worker ──► POST /reps/{id}/location/bulk
   (foreground service)        (durable)          (WorkManager)        (batched, ≤500)
```

The backend is **already built** — this spec only consumes existing endpoints. Do **not** add
backend code.

## 2. Backend contract (already live — read, don't change)

Base URL: `{host}/api/v1`. Auth: `Authorization: Bearer {accessToken}` from login.
All responses use the envelope `{ success, data, timestamp }`. The rep's own `repId` is the
`repId` claim in the JWT / the `user.repId` from the login response — use that as `{id}`.

### 2.1 Single ping — `POST /reps/{id}/location`
Use only for a one-off "locate me now". Normal operation uses bulk (2.2).
```json
// request
{ "lat": 31.95, "lng": 35.91, "accuracyM": 12, "recordedAt": "2026-05-21T10:30:00Z" }
// 201 → data
{ "id": "9223372036854775807", "repId": "uuid", "lat": 31.95, "lng": 35.91,
  "accuracyM": 12, "recordedAt": "2026-05-21T10:30:00Z" }
```
- `lat` ∈ [-90, 90] **required** · `lng` ∈ [-180, 180] **required**
- `accuracyM` ∈ [0, 100000] meters, optional · `recordedAt` ISO-8601, optional (server `now()` if omitted — **always send it**, the queue may flush minutes later).

### 2.2 Bulk pings (offline flush) — `POST /reps/{id}/location/bulk`
**This is the primary endpoint.**
```json
// request — max 500 points per call
{ "points": [
  { "lat": 32.001, "lng": 35.901, "accuracyM": 5, "recordedAt": "2026-05-21T10:00:00Z" },
  { "lat": 32.002, "lng": 35.902, "accuracyM": 8, "recordedAt": "2026-05-21T10:00:15Z" }
] }
// 201 → data
{ "accepted": 2 }
```
Counts as **one** request against the 100-req/60s rate limit regardless of point count.

### 2.3 Read endpoints (for an in-app "my trail today" view, optional)
- `GET /reps/{id}/locations?from&to&limit` → array of pings, ASC by `recordedAt` (limit ≤ 10000, default 1000).
- `GET /reps/locations/latest` → latest ping per active rep with `status` ∈ `online|idle|offline` (manager view; the rep app generally doesn't need it).

### 2.4 Realtime (informational)
Posting a ping makes the backend emit `rep.location` on the `/ws/ops` Socket.io namespace
`{ rep_id, lat, lng, ts }`. The **dashboard** consumes this; the rep app does not need to.
A `rep.offline` event fires after 2h with no ping — keep the cadence well under that.

### 2.5 Errors — envelope
```json
{ "statusCode": 401, "message": "...", "error": "...", "path": "...", "timestamp": "..." }
```
- **401** token expired → trigger re-login, **keep** the queue (do not drop pings).
- **400** validation (bad coord) → drop *that* point, never block the batch — log it.
- **5xx / network** → keep batch, retry with backoff.

## 3. App architecture (FlowVan)

```
feature/tracking/
  data/
    LocationQueueDb.sq          # SQLDelight: queued_location_ping table
    LocationQueueDao.kt          # insert, takeBatch(limit), deleteByIds, count
    TrackingApi.kt               # Ktor client: postBulk(repId, points)
    TrackingRepository.kt        # enqueue(ping); flush(): suspend → drains queue
    dto/
      LocationPingDto.kt         # @Serializable lat/lng/accuracyM/recordedAt
      BulkLocationRequest.kt     # { points: List<LocationPingDto> }
      BulkLocationResponse.kt    # { accepted: Int } under Envelope<T>
  platform/
    LocationProvider.kt          # expect class — start()/stop(): Flow<RawFix>
    LocationProvider.android.kt  # FusedLocationProviderClient
    LocationProvider.ios.kt      # CLLocationManager
  service/
    TrackingForegroundService.kt # Android foreground service (location type)
    TrackingController.kt        # start/stop shift; owns provider + repository
  sync/
    LocationSyncWorker.kt        # WorkManager (Android) / BGTask (iOS) → repository.flush()
  ui/
    TrackingToggle.kt            # "On shift" switch + queued-count + last-sync chip
```

### 3.1 Local queue schema (SQLDelight)
```sql
CREATE TABLE queued_location_ping (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lat         REAL    NOT NULL,
  lng         REAL    NOT NULL,
  accuracy_m  REAL,
  recorded_at TEXT    NOT NULL,   -- ISO-8601 UTC, set at capture time
  created_at  INTEGER NOT NULL    -- epoch millis, for ordering/cleanup
);
CREATE INDEX idx_qlp_created ON queued_location_ping(created_at);
```

### 3.2 DTOs (`kotlinx.serialization`)
```kotlin
@Serializable
data class LocationPingDto(
    val lat: Double,
    val lng: Double,
    val accuracyM: Double? = null,
    val recordedAt: String,            // Instant.toString() — ISO-8601, always set
)

@Serializable data class BulkLocationRequest(val points: List<LocationPingDto>)
@Serializable data class BulkLocationResponse(val accepted: Int)

@Serializable data class Envelope<T>(
    val success: Boolean, val data: T, val timestamp: String,
)
```

### 3.3 Repository
```kotlin
class TrackingRepository(
    private val dao: LocationQueueDao,
    private val api: TrackingApi,
    private val session: Session,         // exposes repId + bearer token
) {
    suspend fun enqueue(fix: RawFix) {
        // accuracy gate: drop fixes worse than 100 m (see §4)
        if (fix.accuracyM != null && fix.accuracyM > 100) return
        dao.insert(fix.lat, fix.lng, fix.accuracyM, fix.recordedAt.toString())
    }

    /** Drains the queue in ≤500-point batches. Returns total accepted. */
    suspend fun flush(): Result<Int> = runCatching {
        val repId = session.repId ?: error("no repId — not a salesman account")
        var total = 0
        while (true) {
            val batch = dao.takeBatch(limit = 500)
            if (batch.isEmpty()) break
            val points = batch.map { it.toDto() }
            val resp = api.postBulk(repId, BulkLocationRequest(points))
            dao.deleteByIds(batch.map { it.id })   // delete only after 201
            total += resp.accepted
        }
        total
    }
}
```
- Delete rows **only after** a 201. A failed/throwing call leaves the batch in the queue.
- A 400 on the whole batch is unexpected (server validates per-point), but if it happens,
  bisect: re-submit halves, drop the offending point. Simpler v1: on 400, drop the oldest
  point and retry once, then move on — log the dropped row.

### 3.4 Capture cadence
- Foreground service requests fixes at **~15 s** interval / **25 m** displacement (whichever first).
- Every fix → `repository.enqueue()`. The service never calls the network directly.
- `recordedAt` is stamped **at capture** (`Clock.System.now()`), not at flush — critical because
  the flush can be minutes/hours later when back online.

### 3.5 Sync trigger
- **Android:** periodic `LocationSyncWorker` every **15 min** with `NetworkType.CONNECTED`,
  **plus** an expedited one-shot enqueued whenever the queue crosses **50 rows** (cheap, keeps
  the live map fresh on good networks). Backoff: exponential, 30 s → 5 min.
- **iOS:** `BGAppRefreshTask` + flush on foreground.
- Flush is also called once on app foreground and on shift-stop.

## 4. Field-quality rules

- **Accuracy gate:** drop fixes with `accuracyM > 100` before enqueue (§3.3). Keeps the trail clean.
- **De-dupe / stationary:** if the new fix is < 10 m from the last enqueued one *and* < 60 s newer,
  skip it — avoids hundreds of identical pings while parked. (Track last-enqueued in memory.)
- **Queue cap:** if the queue exceeds **5000** rows (days fully offline), drop the **oldest**
  beyond 5000 on insert — the dashboard cares about recent movement, and bulk is capped anyway.
- **Battery:** single foreground service, balanced-power priority, stop on shift-end. No tracking
  when "On shift" is off.

## 5. Permissions & lifecycle

| Platform | Needs |
|---|---|
| Android | `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS` (13+). Foreground service type `location`. |
| iOS | `NSLocationAlwaysAndWhenInUseUsageDescription`, `NSLocationWhenInUseUsageDescription`, `UIBackgroundModes: location`. |

- Request **foreground** location first; explain, then request **background** ("Allow all the time")
  — Android 11+ forces this to a second, separate prompt. If background is denied, still track
  while the app is foregrounded and show a banner.
- The "On shift" toggle is the single source of truth: ON → start service + provider; OFF → stop
  both and run a final `flush()`.
- Persist shift state so an OS process-kill auto-restarts the service (`START_STICKY`).

## 6. Auth integration

- Reuse the existing FlowVan `Session` (bearer token + `user.repId` from `/auth/login`).
- A 401 from bulk → emit a re-auth event; **do not** clear the queue. After re-login the next
  scheduled flush drains it.
- If `session.repId == null` (non-salesman login), disable the tracking toggle entirely.

## 7. UI (`TrackingToggle.kt`)

A compact card on the Home screen:
- **On shift** switch (the master control).
- Status chip: `مزامن` (synced) when queue == 0, else `${count} بانتظار المزامنة` (N pending).
- "Last synced HH:mm" from the last successful flush timestamp.
- Permission-needed banner with a button deep-linking to settings when background location is off.

RTL Arabic-first, matching FlowVan's existing screens. Numbers render mono-LTR.

## 8. Acceptance criteria

1. With network ON and "On shift", a fresh fix appears on the dashboard live map
   (`/reps/locations/latest`, status `online`) within ~30 s.
2. Turn airplane mode on, drive/walk 5 min → pings accumulate in `queued_location_ping`
   (visible as the pending count). Restore network → within one sync cycle the queue drains to 0
   and the full trail is retrievable via `GET /reps/{id}/locations` for the offline window,
   with `recordedAt` matching capture time (not flush time).
3. A batch > 500 splits into multiple bulk calls; each returns `accepted` == its point count;
   rows are deleted only after 201.
4. Killing the app process with "On shift" ON → service restarts and tracking resumes.
5. Token expiry mid-shift → 401 surfaces a re-login; **no pings lost**; queue drains after re-auth.
6. "On shift" OFF → no location callbacks fire, foreground-service notification clears, a final
   flush empties the queue.
7. Fixes with `accuracyM > 100` never reach the server; stationary duplicates are de-duped.

## 9. Out of scope (later features)

- Route-stop check-in/out (`POST /routes/stops/{stopId}/visit`) and customer visit logging
  (`POST /customers/{id}/visits`) — separate spec; this F12 is pure GPS streaming.
- Speeding / driver-behavior detection (see F5 — runs server-side over this trail data).
- Consuming the `/ws/ops` socket in the rep app.

## 10. Conventions (inherited)

- API success envelope `{ success, data, timestamp }`; bearer auth; coordinates WGS84 double precision.
- Money is irrelevant here (no fils/JOD), but keep the repo's mono-LTR rule for any numbers shown.
- Verify gate before PR: build + the platform test suite green; manual run of AC #1 and #2.
