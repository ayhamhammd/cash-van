# SPEC — Location ingest: dedupe, bound the clock, keep the partitions healthy

GPS is the highest-volume write in the system and the one with the least protection. A replayed
batch double-counts distance, one bad device clock can permanently break monthly partition
creation, and nothing ever deletes old data.

Scope: `rep_location_events`, `POST /reps/:id/location`, `.../location/bulk`,
`PartitionMaintenanceService`, the tracking summary. Companion:
`SPEC-client-and-server-time.md` (the two-clock rule this applies to pings),
`SPEC-salesman-tracking-history.md` (what reads this data).

---

## 1. What exists today (verified 2026-09-21)

Correct already, and unchanged by this spec: monthly range partitioning, a composite PK
`(id, recorded_at)`, parent-level indexes that propagate to every partition, a bulk endpoint
capped at 500 points (`record-location.dto.ts:47`), the tracking token's deny-by-default scope
guard, and `@AllowTrackingToken()` on exactly the three telemetry routes
(`locations.controller.ts:50`, `:74`, `:94`).

Four defects.

### 1.1 No dedupe key — a replay double-counts the day

`LocationsService.recordBulk` (`locations.service.ts:101`) inserts unconditionally:

    const rows = dto.points.map((p) => this.events.create({ repId, lat, lng, accuracyM,
                                                            recordedAt: … }));
    await this.events.save(rows, { chunk: 100 });

The table has no unique constraint — PK is `(id, recorded_at)` with `id` from a `BIGSERIAL`
(`1715900000000-AddRegionsAndLocationEvents.ts:49`), so every insert is new by construction.

An offline-first client that posts 500 points, loses the response to a dying link, and retries
inserts all 500 **again**. Distance travelled, active minutes and the trail on the map are all
sums over these rows, so they inflate — and the inflation looks like a rep who drove further,
which is the opposite of the conclusion an operator should draw.

### 1.2 `recordedAt` is unbounded, and the DEFAULT partition converts that into an outage

`recordedAt` comes from the device with no validation beyond `@IsDateString()`
(`record-location.dto.ts:38`).

Inserts do not fail, because the schema has a catch-all
(`1715900000000-AddRegionsAndLocationEvents.ts:82`):

    CREATE TABLE "rep_location_events_default" PARTITION OF "rep_location_events" DEFAULT

That was a sound decision — "so a late ping never errors". But it has a consequence that is not
obvious and is worse than a rejected insert.

**A DEFAULT partition holding a row blocks creation of the partition that row belongs to.**
`CREATE TABLE … PARTITION OF … FOR VALUES FROM (a) TO (b)` makes Postgres scan the default
partition, and if any row falls in `[a,b)` it refuses:

    ERROR: updated partition constraint for default partition
           "rep_location_events_default" would be violated by some row

So a single handset with its clock set into the future writes one row into `default`, and then
`PartitionMaintenanceService.ensureNextMonthPartition` (`partition-maintenance.service.ts:39`)
**fails for that month, permanently**. `monthlyTick` (`:64`) has **no try/catch** — unlike the
boot path at `:23` — so it throws inside the scheduler and the only trace is an unhandled
rejection. Every subsequent ping for that month then also lands in `default`, which keeps
growing and keeps blocking, and the table quietly degenerates into one unpartitioned heap.

This is a slow failure with no alarm, triggered by one rep's phone settings.

### 1.3 Nothing is ever deleted

`partition-maintenance.service.ts:17`:

> Old partitions are NOT dropped automatically. A separate retention task (out of scope here)
> can drop partitions older than N months when needed.

That task was never written. At a ping every 30s over a 10-hour shift — 1,200 points per rep per
day — 50 reps produce ~22M rows a year, growing without limit, on the table every tracking query
touches.

### 1.4 `recordedAt` defaults are ambiguous

`RepLocationEvent.recordedAt` is declared `@CreateDateColumn` (`rep-location-event.entity.ts:38`)
while the service explicitly assigns it. A column that is simultaneously "the device's moment"
and "insert time" will be read both ways by whoever comes next. It is a plain column with a
default; declare it that way.

---

## 2. What changes

| | today | after |
|---|---|---|
| Dedupe | none | **`UNIQUE (rep_id, recorded_at)` + `ON CONFLICT DO NOTHING`** |
| Bad clock | silently into `default` | **clamped per point, counted, reported** |
| Batch with one bad point | all-or-nothing chunk | **per-point outcome; the batch still lands** |
| `default` partition | permanent, load-bearing | **kept, but monitored and drained** |
| Partition cron failure | unhandled rejection | **caught, notified, self-healing** |
| Retention | none | **drop partitions older than N months (configurable)** |
| Server time | not recorded | **`received_at`, per `SPEC-client-and-server-time.md`** |
| `recorded_at` declaration | `@CreateDateColumn` | plain column with `DEFAULT now()` |

---

## 3. Schema

`src/database/migrations/1727600000000-LocationIngestIntegrity.ts`

    -- 1. Server clock, per SPEC-client-and-server-time.md. recorded_at keeps its
    --    meaning: the moment on the device.
    ALTER TABLE rep_location_events
      ADD COLUMN received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN clock_skew_ms BIGINT;

    -- 2. Collapse existing duplicates before constraining. Report the count first —
    --    it is the measured size of §1.1 at this site, and it is the number that
    --    every historical distance figure was wrong by.
    --      SELECT count(*) - count(DISTINCT (rep_id, recorded_at)) FROM rep_location_events;
    DELETE FROM rep_location_events a
     USING rep_location_events b
     WHERE a.rep_id = b.rep_id AND a.recorded_at = b.recorded_at AND a.id > b.id;

    -- 3. The dedupe key. On a partitioned table a UNIQUE constraint MUST include
    --    every partition-key column — recorded_at is the partition key, so this is
    --    the natural form anyway. It replaces idx_rle_rep_recorded_desc as the
    --    (rep_id, recorded_at) access path.
    ALTER TABLE rep_location_events
      ADD CONSTRAINT uq_rle_rep_recorded UNIQUE (rep_id, recorded_at);

    -- 4. Partition health, so §4.4 can report instead of guess.
    CREATE TABLE partition_health (
      table_name    TEXT        NOT NULL,
      partition     TEXT        NOT NULL,
      checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      row_estimate  BIGINT,
      status        TEXT        NOT NULL,   -- ok | default_occupied | create_blocked | dropped
      detail        TEXT,
      PRIMARY KEY (table_name, partition, checked_at)
    );

A note on §3.3 for whoever implements it: **one ping per rep per second** is the resolution this
constraint permits. That is far finer than any tracker configuration in use (30s is typical), and
it is the coarsest key that actually dedupes. If a client ever needs sub-second sampling, the key
becomes `(rep_id, recorded_at, lat, lng)` — but not before, because a wider key dedupes less.

---

## 4. Backend

### 4.1 Bulk insert becomes idempotent and per-point

    async recordBulk(repId, dto): Promise<BulkResult> {
      await this.assertRepExists(repId);
      const now = new Date();
      const accepted: Row[] = [];
      const rejected: Array<{ index: number; reason: string }> = [];

      dto.points.forEach((p, i) => {
        const clock = resolveClock(p.recordedAt, now);          // shared helper
        if (clock.suspect && REJECT_SUSPECT_PINGS) {
          rejected.push({ index: i, reason: 'clock_out_of_range' }); return;
        }
        accepted.push({ repId, lat: p.lat, lng: p.lng, accuracyM: p.accuracyM ?? null,
                        recordedAt: clock.businessAt, receivedAt: clock.receivedAt,
                        clockSkewMs: clock.clockSkewMs });
      });

      const res = await this.events.createQueryBuilder()
        .insert().values(accepted).orIgnore()      // ON CONFLICT DO NOTHING
        .execute();

      return { accepted: accepted.length, inserted: res.raw?.length ?? 0,
               duplicates: accepted.length - inserted, rejected };
    }

Four properties:

- **`orIgnore()`** makes the whole batch idempotent. A replay inserts 0 and returns
  `duplicates: 500`, which is the honest answer and costs one index probe per row.
- **One statement, not `save(rows, {chunk:100})`.** The current chunked `save` issues a SELECT
  per row to decide insert-vs-update; a 500-point batch is ~1,000 round trips. This is one.
- **A bad point cannot fail the batch.** Today one unparseable or out-of-range point rejects the
  request and the device retries the same poisoned payload forever. Now the point is named in
  `rejected` and the other 499 land.
- **The response reports outcomes**, so the handset can distinguish "sent" from "stored" and drop
  its local buffer on the right signal.

`record()` (single point) takes the same path with a one-element array, so there is one set of
rules rather than two.

### 4.2 Clock policy for pings

Uses `resolveClock` from `SPEC-client-and-server-time.md` §4.2, with pings held to a tighter
window than documents:

- within tolerance (36h back / 2h forward) → `recorded_at` is the device value. This is the
  normal offline-buffer case and must keep working: a trail recorded in a coverage hole belongs
  at the times it was recorded.
- outside it → **rejected, not clamped.** This is the one place the two-clock spec's "clamp,
  never reject" rule is deliberately inverted, for a specific reason: clamping a ping to
  `received_at` would place the rep at that location *now*, which is a false statement about
  where a person is. A rejected ping loses a dot on a map; a clamped one puts the rep somewhere
  they are not. Rejection is the safer error, and §4.4 makes it visible instead of silent.
- rejected pings increment a per-rep counter surfaced on the Devices page with the same "device
  clock is wrong" guidance as documents.

This also removes §1.2's trigger at the source: no out-of-range `recorded_at` reaches the table,
so nothing new lands in `default`.

### 4.3 Accuracy floor

Add a configurable `LOCATION_MAX_ACCURACY_M` (default 500). A fix with `accuracy_m` above it is
stored but excluded from distance and active-minute computation. Cell-tower fixes with 2 km
accuracy currently enter distance sums as real movement, which is its own source of inflated
mileage — and one that survives fixing §1.1.

Implement the exclusion in the summary query, not by discarding the row: the point is still
evidence the device was awake.

### 4.4 Partition maintenance that cannot fail silently

`PartitionMaintenanceService` gains four things:

1. **Catch in `monthlyTick`**, exactly as `onApplicationBootstrap` already does at `:23`. An
   unhandled rejection in a cron is an outage with no message.
2. **Keep more runway.** Ensure the next **three** months, not one. Then a single failed tick is
   not a cliff, and a client whose server sat powered off for a month recovers on boot.
3. **Handle the blocked-create case explicitly.** When `CREATE TABLE … PARTITION OF` fails
   because `default` holds matching rows, do not just log:

       -- move the offending rows out, then create, then decide what to do with them
       BEGIN;
         CREATE TABLE rle_quarantine_<yyyymm> (LIKE rep_location_events);
         WITH moved AS (
           DELETE FROM rep_location_events_default
            WHERE recorded_at >= $from AND recorded_at < $to
            RETURNING *)
         INSERT INTO rle_quarantine_<yyyymm> SELECT * FROM moved;
         CREATE TABLE rep_location_events_<yyyymm> PARTITION OF rep_location_events
           FOR VALUES FROM ($from) TO ($to);
       COMMIT;

   Then write a `partition_health` row with `status='create_blocked'`, the moved row count, and
   the reps involved, and raise a notification. The quarantined rows are not silently
   re-inserted — they are by definition points with a wrong timestamp, and a human decides.
4. **A daily check** (`@Cron('15 3 * * *')`) recording one `partition_health` row per partition,
   plus a `default_occupied` row whenever `rep_location_events_default` is non-empty. A
   non-empty default partition is the early warning for §1.2, and today nobody can see it.

### 4.5 Retention

    LOCATION_RETENTION_MONTHS (default 18, minimum 3, 0 = keep everything)

`@Cron('45 3 1 * *')` — monthly, `DETACH` then `DROP` each partition wholly older than the
window. `DROP TABLE` on a detached partition is a metadata operation: no row-by-row delete, no
bloat, no vacuum storm. Record each drop in `partition_health` with `status='dropped'` and the
row estimate, so the history of what was removed survives the data.

18 months is chosen to cover a full year-over-year comparison plus a quarter. Put it in
`app_settings` beside the backup retention (`SPEC-backup-configuration.md` §2) so an owner with a
legal retention requirement can set it without a redeploy — and make the UI state plainly that
dropped trails cannot be recovered except from a backup.

### 4.6 Entity tidy-up

    - @CreateDateColumn({ name: 'recorded_at', type: 'timestamptz' })
    + @Column({ name: 'recorded_at', type: 'timestamptz', default: () => 'now()' })
      recordedAt!: Date;

and document in the entity's comment that `recorded_at` is the **device** clock and `received_at`
is the server's — the same vocabulary as every other document, so nobody has to re-derive it.

---

## 5. Mobile contract (KMP)

1. Buffer locally and post in batches of ≤ 500, oldest first.
2. **Drop a buffered point only when the response accounts for it** — `inserted` and
   `duplicates` both mean "the server has it". `rejected` means it will never be accepted; drop
   it and count it locally.
3. Retry the same batch unchanged on any `5xx` or timeout. `orIgnore` makes that free.
4. Capture `recordedAt` with the offset, anchored to `elapsedRealtime()` so a clock correction
   mid-buffer does not rewrite already-queued points (same rule as documents).
5. Respect the accuracy floor client-side too: do not buffer a fix worse than the configured
   threshold unless it is the only fix in the interval.

---

## 6. Acceptance

1. **Replay is free.** Post 500 points, then post the identical batch. Second response:
   `inserted: 0, duplicates: 500`. Row count unchanged. Distance for the day unchanged.
2. **One bad point does not sink the batch.** Post 500 points with one dated 2031. Response:
   `accepted: 499, rejected: [{index, 'clock_out_of_range'}]`. 499 rows stored.
3. **`default` stays empty.** After §4.2, no ingest path can write to
   `rep_location_events_default`. Assert `count(*) = 0` in the integration suite.
4. **Blocked create self-heals.** Insert a future-dated row directly via SQL, then run
   `ensureNextMonthPartition` for that month. The partition is created, the row is quarantined, a
   `partition_health` row records it, a notification fires.
5. **Cron cannot throw.** Make `ensureNextMonthPartition` fail; `monthlyTick` logs and notifies
   without an unhandled rejection.
6. **Retention drops.** Seed 24 monthly partitions. After the job, only the last 18 remain, each
   drop recorded.
7. **Accuracy floor.** Two fixes 2 km apart, both `accuracy_m = 3000`. Distance contribution is
   zero; both rows are stored.
8. **Bulk cost.** A 500-point batch issues **one** insert statement. Assert on the query count,
   because the regression here is invisible in behaviour and obvious in latency.

## 7. Rollout

1. Report the duplicate count on each client **before** the migration — it quantifies how wrong
   historical distance figures were, and the owner should hear that from you rather than discover
   it.
2. Migration: `received_at`, dedupe, constraint, `partition_health`.
3. §4.1 + §4.2 together — the constraint without `orIgnore()` turns today's silent duplicates
   into hard `409`s on every replay, which is worse than the bug.
4. §4.4 partition hardening. Independent, and the highest value per line in this spec: it turns a
   silent, spreading failure into a notification.
5. §4.3 accuracy floor, §4.5 retention — each on its own, each announced, because both change
   numbers the owner has already seen.
