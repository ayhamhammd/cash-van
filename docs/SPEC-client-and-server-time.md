# SPEC — Two clocks, two columns: device time and server time

Every timestamp the business is measured on currently comes from the handset's clock, is
stored in one column, and is never compared against anything. This adds an explicit **device
time** and an explicit **server time** to every document the app creates, and makes the
reports read the one that cannot be moved from the field.

Scope: `voucher_headers`, `collections`, `shifts`, `rep_location_events`, `voucher_inbox`,
and every report that buckets by date. Companion: `SPEC-sync-intake-contract.md` (the intake
that stamps them), `SPEC-location-ingest-integrity.md` (the GPS-specific rules).

---

## 1. What exists today (verified 2026-09-21)

| what | column | who sets it | bound |
|---|---|---|---|
| voucher business date | `voucher_headers.in_date` | **the app**, `CreateVoucherDto.inDate` (`dto:213`), optional, defaults to `now()` | none |
| voucher row insert | `voucher_headers.created_at` | server, via `BaseEntity` | n/a |
| collection time | `collections.collected_at` (`:49`) | the app | none |
| shift open | `shifts.opened_at` (`:36`) | the app, `shifts.service.ts:58` | none |
| shift close | `shifts.closed_at` | the app, `:76` | only `closedAt >= openedAt` |
| GPS ping | `rep_location_events.recorded_at` | the app (`record-location.dto.ts:38`) | none |
| sale position | `sale_lat/lng` | the app | n/a — correctly documented as device-side |

Two observations.

**The server time already exists but is unused.** `VoucherHeader extends BaseEntity`
(`voucher-header.entity.ts:20`), so it has a server `created_at`. Nothing reads it. Every
report buckets on `in_date`: `reports.service.ts:343`, `:353`, `:395`, `:635`, `:829`–`:832`.
`collections` and `shifts` likewise have a `created_at` nobody reads.

**The intent behind device time is correct and must be preserved.** The shift entity says it
plainly:

> The timestamp is the moment on the handset, never the moment the row arrived: a shift that
> syncs after an outage must not be recorded as having started when coverage came back.

That is right. The problem is not that device time is recorded — it is that device time is
recorded *instead of* server time, unbounded, and then used as the basis for money reports.

### 1.1 What that costs

- **A skewed clock rewrites a closed period.** A handset whose date is a month out posts
  sales that land in an already-reported, already-settled month. Nothing refuses it and
  nothing flags it.
- **Late uploads silently change yesterday.** A document made at 23:50 and synced at 08:00 is
  filed under the previous day. An EOD report printed and signed last night no longer
  reproduces. Re-running it after the sync gives a different number, with no record that
  anything arrived in between.
- **Sync latency is unmeasurable.** There is no way to ask "how long did this document sit on
  a handset?", so a rep holding sales offline, or a device that has silently stopped syncing,
  is invisible until someone notices the absence.
- **`closedAt >= openedAt` is the only sanity check in the system**, and it passes happily for
  a shift that opened in 2019.

---

## 2. What changes

Every document the handset originates carries **both** clocks, in named columns:

| column | meaning | source | nullable |
|---|---|---|---|
| `client_created_at` | the moment on the handset, exactly as sent, **never adjusted** | device | yes — a dashboard-created document has no device |
| `received_at` | the moment the server durably accepted it | server | **no** |
| `clock_skew_ms` | `received_at − client_created_at`, in ms, stored so it is queryable | server | yes |

and the existing business-date column becomes **derived and bounded** rather than raw input.

| | today | after |
|---|---|---|
| device time | overloaded onto the business column | **`client_created_at`, kept raw** |
| server time | `created_at`, unread | **`received_at`, non-null, indexed** |
| `in_date` / `collected_at` / `opened_at` | whatever the app sent | **clamped to `received_at` ± tolerance** |
| out-of-tolerance document | accepted silently | accepted, clamped, **flagged** |
| reports | bucket on device time | **bucket on `received_at`** (§4.3) |
| skew | invisible | queryable, on the device page, alarmed above a threshold |

Nothing is rejected for a bad clock. A rep with a wrong phone clock must still be able to
sell; the document is accepted, the raw device value is preserved for the audit trail, and the
business date is the one the server can stand behind.

---

## 3. Schema

`src/database/migrations/1727300000000-ClientAndServerTime.ts`

    -- Vouchers -------------------------------------------------------------
    ALTER TABLE voucher_headers
      ADD COLUMN client_created_at TIMESTAMPTZ,
      ADD COLUMN received_at       TIMESTAMPTZ,
      ADD COLUMN clock_skew_ms     BIGINT,
      -- TRUE when in_date was moved by the clamp in §4.2. The flag, not the
      -- absence of one, is what the dashboard filters on.
      ADD COLUMN client_time_suspect BOOLEAN NOT NULL DEFAULT FALSE;

    -- Backfill: the best available truth for history. in_date is what the app
    -- said; created_at is when the row was inserted, which for an inbox-promoted
    -- document is when the server accepted it.
    UPDATE voucher_headers
       SET client_created_at = in_date,
           received_at       = created_at,
           clock_skew_ms     = EXTRACT(EPOCH FROM (created_at - in_date)) * 1000;

    ALTER TABLE voucher_headers ALTER COLUMN received_at SET NOT NULL;
    ALTER TABLE voucher_headers ALTER COLUMN received_at SET DEFAULT now();

    CREATE INDEX idx_voucher_headers_received_at ON voucher_headers (received_at);
    CREATE INDEX idx_voucher_headers_suspect
      ON voucher_headers (received_at) WHERE client_time_suspect;

    -- Collections ----------------------------------------------------------
    ALTER TABLE collections
      ADD COLUMN client_created_at TIMESTAMPTZ,
      ADD COLUMN received_at       TIMESTAMPTZ,
      ADD COLUMN clock_skew_ms     BIGINT,
      ADD COLUMN client_time_suspect BOOLEAN NOT NULL DEFAULT FALSE;
    UPDATE collections SET client_created_at = collected_at,
                           received_at = created_at,
                           clock_skew_ms = EXTRACT(EPOCH FROM (created_at - collected_at)) * 1000;
    ALTER TABLE collections ALTER COLUMN received_at SET NOT NULL;
    ALTER TABLE collections ALTER COLUMN received_at SET DEFAULT now();
    CREATE INDEX idx_collections_received_at ON collections (received_at);

    -- Shifts ---------------------------------------------------------------
    -- opened_at/closed_at stay as the handset's moments (that is their purpose).
    -- The server moments are added beside them, one per event.
    ALTER TABLE shifts
      ADD COLUMN open_received_at   TIMESTAMPTZ,
      ADD COLUMN close_received_at  TIMESTAMPTZ,
      ADD COLUMN open_skew_ms       BIGINT,
      ADD COLUMN close_skew_ms      BIGINT,
      ADD COLUMN client_time_suspect BOOLEAN NOT NULL DEFAULT FALSE;
    UPDATE shifts SET open_received_at = created_at,
                      open_skew_ms = EXTRACT(EPOCH FROM (created_at - opened_at)) * 1000;
    ALTER TABLE shifts ALTER COLUMN open_received_at SET NOT NULL;
    ALTER TABLE shifts ALTER COLUMN open_received_at SET DEFAULT now();

    -- Locations: see SPEC-location-ingest-integrity.md §3. recorded_at stays
    -- the device moment; received_at is added there together with the dedupe key.

    -- Intake: skew is known at the door, before promotion.
    ALTER TABLE voucher_inbox
      ADD COLUMN client_created_at TIMESTAMPTZ,
      ADD COLUMN clock_skew_ms     BIGINT;

Note what is **not** done: `in_date`, `collected_at` and `opened_at` are not renamed and not
dropped. Installed APKs send them and the dashboard reads them. They keep their names and
gain a guarantee about their contents.

---

## 4. Backend

### 4.1 The DTOs gain the device clock explicitly

    // CreateVoucherDto, CreateCollectionDto, OpenShiftDto, CloseShiftDto
    @ApiPropertyOptional({
      description: "The moment on the handset, ISO 8601 WITH offset. Sent as the device " +
                   "recorded it — never corrected. The server stores it raw and derives " +
                   "the business date itself.",
    })
    @IsOptional() @IsDateString()
    clientCreatedAt?: string;

`inDate` stays in the DTO for compatibility. When both arrive, `clientCreatedAt` wins as the
device clock and `inDate` is ignored — a new APK sends the explicit field, an old one keeps
working through the fallback.

**Require the offset.** `@IsDateString()` accepts `2026-09-21T23:50:00` with no zone, which
Postgres then reads in the server's timezone. A van in a different zone from the server, or a
server whose `TZ` changes between deploys, silently shifts the value. Add a regex check that
the string ends in `Z` or `±HH:MM`, and reject one that does not — this is the single cheapest
correctness win in the spec.

### 4.2 One clamp, one place

    // src/common/time/client-clock.ts
    export const CLIENT_TIME_TOLERANCE_MS = 36 * 60 * 60 * 1000;  // 36h back
    export const CLIENT_TIME_FUTURE_MS    =  2 * 60 * 60 * 1000;  // 2h forward

    export interface ResolvedClock {
      clientCreatedAt: Date | null;   // raw, as sent
      receivedAt: Date;               // server now()
      clockSkewMs: number | null;
      businessAt: Date;               // what in_date / collected_at becomes
      suspect: boolean;
    }

    export function resolveClock(clientIso: string | undefined, now = new Date()): ResolvedClock

Rules:

- No device value → `businessAt = receivedAt`, `suspect = false`. A dashboard-created document
  is not suspicious, it simply has one clock.
- Within tolerance → `businessAt = clientCreatedAt`. This is the normal offline case and the
  behaviour the shift entity's comment asks for: a document made in a coverage hole keeps the
  moment it was made.
- More than 36h in the past, or more than 2h in the future → `businessAt = receivedAt`,
  `suspect = true`. The raw value is still stored in `client_created_at`; only the business
  date is refused.

Why those numbers: 36h covers an overnight outage plus a full following shift, which is the
longest gap a van is expected to survive without any coverage. 2h forward is a timezone
mistake or a badly set clock, never a real event — nothing is created in the future. Both
belong in `app_settings` so a client with genuinely worse connectivity can widen the window
without a deploy.

The function is called in exactly three places — `SyncService.ingestVoucher`,
`SyncService.ingestCollection`, `ShiftsService.open`/`close` — and nowhere else. A clamp
implemented twice will disagree with itself.

### 4.3 Reports bucket on server time

This is the part with a business consequence, so it is stated as a rule rather than a
refactor: **a report over a date range answers "what the books recorded in this range", which
is `received_at`.** A document that arrives late appears in the day it arrived, and the day it
was made is available beside it.

| report | today | after |
|---|---|---|
| EOD / settlement | `in_date` | `received_at` |
| sales by rep / by day, dashboards (`:829`–`:832`) | `in_date` | `received_at` |
| targets, commission | `in_date` | `received_at` |
| tracking map, visit history | `in_date` | **`client_created_at`** — this one is about where the rep was |
| ERP export | unchanged — the ERP gets `in_date` as the document date | unchanged |

Every changed report grows a second column, "made at" (`client_created_at`), and a late-arrival
marker where `received_at::date <> client_created_at::date`. The number stops moving after the
fact, and the thing that used to move is now visible as its own fact.

`SPEC-end-of-day-report.md` and `SPEC-eod-rep-cash-accounts.md` must be amended to say which
clock they settle on. Do not leave that to the reader.

### 4.4 Skew becomes an operational signal

- `GET /api/v1/reps/:id/sync-health` → last `received_at`, last `client_created_at`, current
  `clock_skew_ms` (from the most recent document), count of `client_time_suspect` documents in
  the last 30 days, and the oldest document still `accepted` in the inbox.
- A rep whose median skew exceeds 10 minutes, or who has any suspect document, is flagged on
  the Devices page with "device clock is wrong — ask the rep to enable automatic date & time".
- A rep with no `received_at` in 24h while their device is heartbeating raises a notification.
  A silent handset is the failure this spec makes detectable.

---

## 5. Mobile contract (KMP)

1. Send `clientCreatedAt` on every document, captured at creation, **in ISO 8601 with the
   device's UTC offset**. Never re-stamp on retry — the whole point is the moment of the sale.
2. Capture it from a monotonic-anchored wall clock: record `System.currentTimeMillis()` *and*
   `elapsedRealtime()` at creation, so a clock change between creation and sync does not move
   an already-queued document's timestamp.
3. Read the server's `Date` header on every response and keep a rolling offset estimate. When
   it exceeds 5 minutes, show the rep a non-blocking banner: *"ساعة الجهاز غير صحيحة — شغّل
   التاريخ والوقت التلقائي"*. Do **not** silently correct the stored timestamps; the server's
   clamp is the authority and a client-side correction would hide the problem from §4.4.
4. The intake response echoes `receivedAt` and `businessAt`. When `businessAt` differs from
   what was sent, surface it on the document so the rep is not surprised by the date on the
   dashboard.

---

## 6. Acceptance

1. **Both clocks stored.** Post a SALE with `clientCreatedAt` 3h in the past. `client_created_at`
   = the sent value, `received_at` ≈ now, `clock_skew_ms` ≈ 10,800,000, `in_date` = the sent
   value, `suspect` false.
2. **Backdate beyond tolerance is clamped, not lost.** Post with `clientCreatedAt` 40 days
   past. `client_created_at` = the sent value; `in_date` = `received_at`;
   `client_time_suspect` true.
3. **Future is refused as a business date.** `clientCreatedAt` = now + 5h → `in_date` =
   `received_at`, suspect true.
4. **Zoneless is rejected.** `clientCreatedAt = '2026-09-21T23:50:00'` → `400`.
5. **A closed period stays closed.** Run the EOD report for yesterday; sync a backdated
   document; re-run. **Identical output.** Then confirm the document appears in today's report
   with a late-arrival marker.
6. **Shift sanity.** Open a shift with `openedAt` a year ago: the row keeps the device value in
   `opened_at`, carries `open_received_at` = now, and is flagged.
7. **No device, no suspicion.** A dashboard-created voucher has `client_created_at` NULL,
   `received_at` set, `suspect` false.

## 7. Rollout

1. Migration with the backfill. Purely additive; every existing report still reads `in_date`
   and is unaffected.
2. `resolveClock` + the three call sites + `clientCreatedAt` on the DTOs. Old APKs continue on
   the `inDate` fallback and now get a clamp and a skew measurement.
3. `/sync-health`, the Devices flag, the notification.
4. **The report cut-over, on its own release,** announced to the owner before it ships. Numbers
   for days that contain late arrivals will change once, by design, and that has to be a
   conversation rather than a surprise. Keep the old bucketing available behind a query
   parameter (`bucketBy=client|server`) for one release so the two can be compared on real data.
