# SPEC — Sync intake contract: a document the handset can trust

Closes the two ways a van sale can disappear today: an intake that **reports success for a
document that never posted**, and an idempotency check that **is not atomic**.

Scope: `POST /api/v1/sync/vouchers`, `POST /api/v1/sync/collections`, `voucher_inbox`,
and the handset's local outbox. Companion specs: `SPEC-client-and-server-time.md` (the
timestamps this intake now records), `SPEC-transactional-outbox.md` (what happens after a
document posts).

---

## 1. What exists today (verified 2026-09-21)

The staging design is right and stays. `src/modules/sync/entities/voucher-inbox.entity.ts`
documents it: the app never writes the main tables, it posts to `voucher_inbox`, and a row
that fails promotion stays there for review. That part is not in question.

Three defects sit on top of it.

### 1.1 A failed document is returned as `201 Created`

`SyncService.ingestVoucher` (`src/modules/sync/sync.service.ts:75`) returns:

    { id, voucherNumber, status: 'failed', error }

inside a **`201`**, because `promoteVoucher` (`:172`) swallows every exception into
`markFailed` (`:214`). A handset that keys on the HTTP status — the ordinary thing for an
HTTP client to do — records the document as synced and is free to drop its local copy. The
sale then exists only as a `failed` inbox row.

### 1.2 Nothing retries

`retry()` (`:129`) is reachable only from `POST /sync/inbox/:id/retry`, which is
`@Roles('admin','manager')`. There is **no scheduled drain**. A `failed` row waits for a
human who has no reason to look. Contrast `ErpOutboxService.drain()`
(`src/modules/erp-sync/erp-outbox.service.ts:166`), which has attempts, `next_attempt_at`,
backoff and a dead-letter state. The inbox has none of that: `voucher_inbox` has no
`attempts` and no `next_attempt_at` column at all.

### 1.3 Idempotency is check-then-insert

`:41` and `:89`:

    const existing = await this.inbox.findOne({ where: { clientRef } });
    if (existing) return …;
    …
    await this.inbox.save(…);

Two concurrent replays of the same `clientRef` — which is exactly what an offline-first
client produces when a request times out on a dying link but succeeds server-side — both
miss the `findOne` and both reach `save`. The partial unique index
`uq_voucher_inbox_client_ref` saves the database, and hands the loser a raw Postgres
`23505` that leaves the controller as a 500. The handset reads 500 as "retry", and does,
forever.

`clientRef` is also **optional** (`src/modules/sync/dto/sync.dto.ts:13`, `@IsOptional()`).
An app build that omits it gets silent duplicates with no index to stop them.

### 1.4 Related: the assigned number can be unusable

`:58` keeps the app's own `voucherNumber` when present. `voucher_headers.voucher_number` is
`UNIQUE` (`voucher-header.entity.ts:21`). A reinstall, a restored backup or a replaced
handset resets the app's local sequence, so it re-mints a number that already posted — and
that document can then **never** be promoted, because every retry fails identically on the
unique violation. §4.4 addresses this without taking the app's number away.

---

## 2. What changes

| | today | after |
|---|---|---|
| HTTP status for a rejected document | `201` | **`202` always; body carries the verdict** |
| Verdict vocabulary | `pending \| posted \| failed` | `accepted \| posted \| rejected` + `attempts` |
| `clientRef` | optional | **required** on both sync routes |
| Dedupe | `findOne` then `save` | **`INSERT … ON CONFLICT DO NOTHING RETURNING`** |
| Retry | manual, dashboard only | **scheduled drain with backoff + dead-letter** |
| Device confirmation | none | **`GET /sync/status?clientRefs=…`** |
| Duplicate app number | permanent failure | **re-numbered under the server sequence, app number kept** |

The contract the handset codes against becomes: *a `2xx` means the server has durably
accepted responsibility for this document. Only `posted` (or `rejected`) means you may drop
your local copy.*

---

## 3. Schema

`src/database/migrations/1727000000000-SyncIntakeContract.ts`

    -- Retry state, mirroring erp_outbox so the two queues behave alike.
    ALTER TABLE voucher_inbox
      ADD COLUMN attempts         INTEGER     NOT NULL DEFAULT 0,
      ADD COLUMN next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN last_attempt_at  TIMESTAMPTZ,
      -- The number the APP minted, kept even when §4.4 re-numbers the document,
      -- so a rep reading their handset and a clerk reading the dashboard can still
      -- find each other.
      ADD COLUMN client_number    TEXT;

    -- 'failed' is retained as a legacy read value; new rows use the vocabulary in §2.
    -- 'dead_letter' is terminal: MAX_ATTEMPTS burnt, or a terminal validation error.
    ALTER TABLE voucher_inbox DROP CONSTRAINT IF EXISTS chk_voucher_inbox_status;
    ALTER TABLE voucher_inbox ADD CONSTRAINT chk_voucher_inbox_status
      CHECK (status IN ('accepted','posted','rejected','dead_letter','pending','failed'));

    -- The drain's only index. Partial, because posted rows are the vast majority
    -- and must never be scanned.
    CREATE INDEX idx_voucher_inbox_due
      ON voucher_inbox (next_attempt_at)
      WHERE status IN ('accepted','pending');

    -- clientRef becomes mandatory going forward. Existing NULLs are backfilled
    -- from the row id so the index can be made total without losing history.
    UPDATE voucher_inbox SET client_ref = 'legacy:' || id::text WHERE client_ref IS NULL;
    DROP INDEX IF EXISTS uq_voucher_inbox_client_ref;
    ALTER TABLE voucher_inbox ALTER COLUMN client_ref SET NOT NULL;
    CREATE UNIQUE INDEX uq_voucher_inbox_client_ref ON voucher_inbox (client_ref);

A **total** unique index, not partial: the `ON CONFLICT` in §4.1 needs a single unambiguous
arbiter, and a partial index only arbitrates for rows matching its predicate.

---

## 4. Backend

### 4.1 Atomic intake

Replace the `findOne`/`save` pair in `ingestVoucher` and `ingestCollection` with one
statement. TypeORM's query builder is enough:

    const inserted = await this.inbox
      .createQueryBuilder()
      .insert()
      .values({ type, clientRef, repId, userCode, assignedNumber, clientNumber, payload,
                status: 'accepted' })
      .orIgnore()            // → ON CONFLICT DO NOTHING
      .returning('*')
      .execute();

    const row = inserted.raw[0]
      ?? await this.inbox.findOneByOrFail({ clientRef });   // we lost the race

`inserted.raw` empty is the **normal replay path**, not an error: another request already
owns this `clientRef`. Read that row and answer from it. No 500, no retry storm.

Order matters: the insert must happen **before** any number is reserved. Today `:58`
reserves a number and only then saves, so a replay that races burns a sequence value and
throws it away. Reserve inside the winner's branch only.

### 4.2 Verdict, not HTTP status

`SyncVoucherResultDto` becomes:

    {
      id: string;              // inbox row id
      clientRef: string;       // echoed, so the app can match without positional trust
      voucherNumber: string;   // authoritative; may differ from the app's (see 4.4)
      clientNumber?: string;   // the app's own number, echoed back
      status: 'accepted' | 'posted' | 'rejected';
      attempts: number;
      error?: string | null;   // present only on 'rejected'
      retryable: boolean;      // 'accepted' → true; 'posted'/'rejected' → false
    }

- Controller returns **`202 Accepted`** for every outcome. `@HttpCode(HttpStatus.ACCEPTED)`
  on both routes; drop `@ApiCreatedResponse`.
- `accepted` — durably staged, promotion has not succeeded yet (either not attempted, or
  attempted and retryable). **The app keeps its local copy.**
- `posted` — in the main tables. The app may drop its copy.
- `rejected` — terminal. The app may drop its copy and must surface it to the rep, because
  a human has to act (wrong customer, missing return reference, duplicate).

A `5xx` keeps its current meaning: nothing is known, retry.

### 4.3 The drain

New `SyncInboxDrainService`, modelled directly on `ErpOutboxService`:

    const MAX_ATTEMPTS = 8;
    const BACKOFF = [30_s, 2_min, 10_min, 30_min, 2_h, 6_h, 12_h, 24_h];

    @Interval(SYNC_INBOX_DRAIN_MS ?? 20_000)
    async drain() {
      // Claim, don't read — see §4.5.
      const due = await claim(BATCH = 20);
      for (const row of due) await this.promote(row);
    }

Classify the promotion failure rather than treating every exception alike — the ERP outbox
already learned this lesson and named the class `TerminalPayloadError`
(`erp-outbox.service.ts:57`). Reuse the idea:

| failure | status | why |
|---|---|---|
| insufficient van stock | `accepted`, backoff | a load voucher may still be in the queue behind it |
| unknown customer / item | `accepted`, backoff | the catalog sync may not have landed yet |
| `voucher_number` already exists | re-number per §4.4, retry at once | not a data problem |
| validation error in the payload | `rejected` | no retry invents a valid body |
| credit limit exceeded, proximity refused | `rejected` | a manager must act; retrying just hides it |
| `MAX_ATTEMPTS` burnt | `dead_letter` | stop, and page a human |

Rejected and dead-lettered rows raise a notification through the existing notifications
module — an inbox nobody reads is the defect we are fixing, so the queue must **push**.

### 4.4 Duplicate app numbers are re-numbered, not refused

In `promoteVoucher`, when `vouchers.create` fails on the unique violation for
`voucher_number` **and** the existing voucher's `client_ref` is not this row's:

1. keep the app's number in `voucher_inbox.client_number`,
2. take a fresh number from `vouchers.reserveVoucherNumber(transKind, store)`,
3. write it to `assigned_number`, promote, and return `posted` with the **new**
   `voucherNumber` and the original `clientNumber`.

The document reaches the books, the rep's paper trail still resolves, and the collision is
recorded in the audit log instead of becoming an immovable row. (The strategic fix — the
server owning the series outright — is a separate decision; this makes today's series
survivable either way.)

### 4.5 Claim, don't read

`drain()` must claim its batch so two API instances cannot promote the same row twice:

    UPDATE voucher_inbox SET status = 'accepted',
                             attempts = attempts + 1,
                             last_attempt_at = now(),
                             next_attempt_at = now() + $backoff
     WHERE id IN (
       SELECT id FROM voucher_inbox
        WHERE status IN ('accepted','pending') AND next_attempt_at <= now()
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *;

`FOR UPDATE SKIP LOCKED` is the whole mechanism. Note this makes the drain safe on more
than one instance — but the rest of the scheduler layer is not yet (in-process `@Interval`
with instance-local mutex flags, socket.io without a Redis adapter). That is out of scope
here and unchanged by this spec; the claim is written this way so the inbox is not the thing
blocking it later.

### 4.6 Device confirmation

    GET /api/v1/sync/status?clientRefs=a,b,c        (max 200 refs)
    → { items: [ { clientRef, status, voucherNumber, attempts, error } ] }

The handset calls this on reconnect for everything still in its local outbox and reconciles:
`posted` or `rejected` → clear locally; `accepted` → keep waiting; **absent** → the intake
never landed, re-POST it.

That last case is the one the app cannot currently distinguish from success, and it is why
this endpoint is the load-bearing part of the spec.

### 4.7 Attribution

`resolveRepId(voucher.userCode)` (`:53`) and `repId: collection.repId` (`:99`) take the
acting rep from the **request body**. Both routes must instead derive it from the token and
reject a mismatch. That is specified in full in
`SPEC-dashboard-voucher-on-behalf.md` §3, which also defines the one legitimate way a
dashboard user acts for a salesman; do not implement it twice.

### 4.8 Delete the dead path

`SyncService.queueErpPush` (`:192`) is unreferenced — the enqueue happens via
`erp.voucher.posted` (`erp-sync.service.ts:634`). It duplicates that logic with different
behaviour. Remove it rather than leave a second door for someone to wire up.

---

## 5. Mobile contract (KMP)

The handset's local outbox gets a state machine that matches the server's:

    QUEUED ──POST──> AWAITING_SERVER ──202 accepted──> AWAITING_PROMOTION
                              │                                │
                              │ 202 posted                     │ GET /sync/status
                              ├────────────────> DONE  <───────┤ posted
                              │ 202 rejected                   │ rejected
                              └────────────────> NEEDS_ATTENTION <┘
                              5xx / timeout → back to QUEUED (same clientRef)

Rules, stated so they can be tested:

1. `clientRef` is minted **once**, at document creation, and never regenerated — not on
   retry, not on app restart, not after a reinstall. A UUIDv4 stored with the document.
2. A document leaves local storage only on `posted` or `rejected`. Never on a `2xx` alone.
3. `NEEDS_ATTENTION` is visible to the rep with the server's `error` text, and counted on
   the home screen. A rejection the rep cannot see is the same failure we started with.
4. Retries use the same `clientRef` with exponential backoff and no cap on lifetime — a
   document may sit queued for days, and that is correct.
5. On reconnect, reconcile the whole outbox through `GET /sync/status` **before** posting
   anything new, so a document that actually landed is not re-posted needlessly.

---

## 6. Dashboard

The inbox screen (`/sync/inbox`) gains: `attempts`, `next_attempt_at`, `dead_letter` as a
filter, and a re-numbered badge where §4.4 fired. `pending`/`failed` keep rendering for
historical rows.

`PATCH /sync/inbox/:id` (payload replacement, `sync.service.ts:113`) currently accepts
untyped `Record<string, unknown>` and keeps no before/after record. It must validate the new
payload against `CreateVoucherDto`/`CreateCollectionDto` and write the previous payload to
`audit_log`. Rewriting a money document with no diff is not an edit, it is a hole.

---

## 7. Acceptance

1. **Concurrent replay.** Fire 20 simultaneous POSTs with one `clientRef`. Exactly one
   `voucher_inbox` row; twenty `202`s; no 5xx; one voucher in `voucher_headers`.
2. **Rejection is visible.** Post a SALE for an unknown customer. Response is
   `202 { status:'rejected', retryable:false, error }`. Nothing in `voucher_headers`.
3. **Retry works unattended.** Post a SALE for stock the van does not hold, then post the
   load TRANSFER. With no human action, the sale promotes on a later drain tick and
   `GET /sync/status` reports `posted`.
4. **Duplicate number survives.** Post two documents with different `clientRef`s and the
   same `voucherNumber`. Both end `posted`; the second carries a different `voucherNumber`
   and its original in `clientNumber`.
5. **Dead letter.** Force 8 retryable failures. Row lands `dead_letter`, a notification
   fires, the drain stops touching it.
6. **Lost intake is recoverable.** Kill the API mid-POST. The handset finds the `clientRef`
   absent from `/sync/status` and re-posts successfully.
7. **`clientRef` is mandatory.** A POST without one is `400`.

## 8. Rollout

The migration is additive and back-compatible: `pending`/`failed` stay legal, so an
installed APK reading `status` keeps working. Ship in this order —
(a) migration, (b) atomic intake + `/sync/status` + drain, with the controller still
returning `201` and the old vocabulary; (c) flip to `202` and the new vocabulary behind
`X-Sync-Contract: 2` sent by the new APK, so old and new handsets coexist during the fleet
update; (d) drop the legacy branch once no `X-Sync-Contract`-less device has synced for 30
days.
