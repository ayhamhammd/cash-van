# PLAN — Reliability hardening: the nine specs, and the order to build them

Umbrella for the specs written on 2026-09-21 out of a design review of the offline-first /
ERP-integrated system. Each spec stands alone and states its own verified starting point; this
file exists for the two things a reader cannot get from any single one: **what depends on what**,
and **what to build first**.

---

## The specs

| # | spec | what it fixes |
|---|---|---|
| 1 | [SPEC-sync-intake-contract.md](SPEC-sync-intake-contract.md) | a document reported as synced that never posted; non-atomic idempotency; no automatic retry |
| 2 | [SPEC-stock-write-integrity.md](SPEC-stock-write-integrity.md) | lost updates on van stock; the silent `Math.max(0, …)` clamp; `reserved` never released |
| 3 | [SPEC-transactional-outbox.md](SPEC-transactional-outbox.md) | a posted voucher that is never queued for the ERP, and nothing that looks for it |
| 4 | [SPEC-client-and-server-time.md](SPEC-client-and-server-time.md) | device clock as the basis for every money report; no server timestamp; no skew measurement |
| 5 | [SPEC-backup-configuration.md](SPEC-backup-configuration.md) | backup is a command in a deploy doc that a human must remember to run |
| 6 | [SPEC-mobile-delta-sync.md](SPEC-mobile-delta-sync.md) | the handset re-downloads the whole catalog because no endpoint answers "what changed?" |
| 7 | [SPEC-location-ingest-integrity.md](SPEC-location-ingest-integrity.md) | replayed GPS batches inflate distance; a bad clock can break partition creation; no retention |
| 8 | [SPEC-erp-authoritative-stock.md](SPEC-erp-authoritative-stock.md) | the ERP re-queried on every read, never stored, drift found by hand |
| 9 | [SPEC-dashboard-voucher-on-behalf.md](SPEC-dashboard-voucher-on-behalf.md) | any authenticated caller can post in another rep's name — and no sanctioned way to do it deliberately |

---

## Dependencies

    9 (§3.1 guard fix) ──┬──> 1 ──> 3
                         │         │
                         └──> 6    └──> 8 (§5 drift)
                                    ▲
    2 ─────────────────────────────┘   (2 supplies stock_integrity_findings)
    2 ────────────> 9 (§4.4: office and rep writing one van concurrently)
    4 ────────────> 1 (§4.6), 7 (§4.2)   (resolveClock is shared)

Hard ones:

- **9 §3.1/§3.2 before 1 and 6.** Both add or change app-facing routes. Deriving the acting rep
  from the token has to be settled first, or the new surface inherits the same hole.
- **2 before 9 §4.** On-behalf vouchers make "office and rep write the same van at the same
  moment" routine. Without the row lock that is a data-loss feature.
- **4 before 1 §4.6 and 7 §4.2.** `resolveClock` is defined once in spec 4 and used by both.
- **2 §4.4 with 2 §4.2, never apart.** Spelled out in spec 2; repeated here because splitting
  them across releases turns a latent bug into refused sales on every van.
- **3's sweep before 3's cut-over.** Two enqueue paths guarded by the unique constraint is the
  safe intermediate state.
- **6 §4.7 before the APK adopts 6.** Without suppressing no-op ERP writes, the first thing the
  new delta endpoint does in production is stream the whole catalog anyway.

Independent, ship whenever: **5**, **7 §4.4** (partition hardening), **8 §1–4** up to the read
cut-over.

---

## Order

**Now — active loss, small changes.** ✅ **Shipped 2026-09-21** (`3a19012`, `aca297b`).

1. ✅ 9 §3.1 + §3.2 — the authorization hole. The acting rep comes from the token; naming
   another rep needs `vouchers.createOnBehalf` and resolves to *that* rep.
   `MobileContextGuard` no longer skips its ownership check for a caller with no rep link.
2. ✅ 2 §3 + §4.1 + §4.2 — advisory lock per `(store, item, pool)`; atomic guarded upserts on
   `van_stock`, `damaged_stock` and the fulfil release; the two missing CHECK constraints;
   `stock_integrity_findings`.
3. ✅ 1 §4.1 + §4.2 + §4.6 — atomic claim, `202` with a verdict, `GET /sync/status`.
4. ✅ 7 §4.4 — `monthlyTick` catches, keeps three months of runway, counts rows stranded in the
   DEFAULT partition, and raises it to the managers' inbox.

Not yet done from those specs: **2 §4.4** (release `reserved` on ORDER *cancel* — fulfil already
releases it) and **2 §5** (drift detection), both deliberately deferred to the tiers below.

### What implementation corrected in the specs

Four claims did not survive contact with the code. Each is now marked in its own spec, because
a spec that misleads the next reader is worse than no spec:

| claim | reality |
|---|---|
| `@Roles('salesman', …)` guards `/sync/*` | No such role. `UserRole` is `admin \| manager \| supervisor \| viewer`; a salesman is a `userType` with a `repId`. The rep resolution **is** the authorization. |
| `van_stock` is the lockable authority for the availability check | It is written **only** on the draft-`post()` path. `create()` — every promoted handset document — moves stock through `voucher_transactions` alone. So the lock is an advisory lock on the pool key, not a row lock. |
| `reserved` is never released | `fulfil()` releases it. The `AiChecks.ts:34` note saying otherwise is stale. What actually leaks is **cancellation**. |
| `van_stock.quantity` has no CHECK, so the DB won't catch an overdraft | It has had one since `1716100000000`. The `Math.max(0, …)` clamp was *load-bearing* — it kept the constraint from firing. The defect is that an overdraft was written as `0` instead of refused. |

Both migrations were run **and reverted** against a live database before shipping.

**Next — money correctness.**

5. 1 §4.3 + §4.5 — the unattended drain with backoff and dead-letter.
6. 3 — transactional outbox, in its four steps. Run the sweep manually on each client first; what
   it finds is invoices missing from the ERP today.
7. 4 §1–§4.2 — both clocks stored, one clamp, skew measured. Reports still read `in_date`.
8. 5 — backup configuration. Independent of everything and the largest single reduction in
   worst-case exposure per day of work.

**Then — cost and visibility.**

9. 8 — ERP stock snapshot. Shadow-run and diff before cutting reads over.
10. 6 — delta sync, §4.7 first.
11. 7 §4.1–4.3 + §4.5 — dedupe, clock policy, accuracy floor, retention.
12. 2 §5 + 8 §5 — drift detection and the stock integrity page.
13. 9 §4 + §6 — the on-behalf feature.
14. 4 §4.3 — the report cut-over to `received_at`.
15. 9 §3.3 — default-deny guards, with the route-coverage test.

Two of these change numbers the owner has already seen — **4 §4.3** (days containing late
arrivals) and **9 §4.3** (managers currently bypass rep-level rules silently). Both are announced
before they ship, not explained afterwards.

---

## Not covered here

Named so they are not mistaken for oversights:

- **Horizontal scalability.** In-process `@Interval`/`@Cron` with instance-local mutex flags, and
  socket.io with no Redis adapter, make the API single-instance: no HA, and no rolling deploy
  without dropping every van's socket and stalling the outbox. Specs 1 §4.5 and 3 §4.3 use
  `FOR UPDATE SKIP LOCKED` and advisory locks so the queues are not what blocks it later, but the
  scheduler and socket layers are untouched.
- **Multi-tenancy.** There is no `tenant_id` anywhere; `app_settings` is a single row and each
  client is a separate deployment with hand-built image tarballs. That is a product decision, not
  a defect, and it needs its own document — owning the per-client fleet properly (one pipeline,
  automated migration with a backup gate, a tenant registry, version telemetry) versus pooling.
  Spec 5 is the first piece of the former either way.
- **Refresh tokens.** A 12h access token with no refresh route means an offline handset whose token
  expires mid-shift cannot upload until the rep re-enters a password. The device row and its
  revocation path already exist (`devices.claim`, the tracking token's kill switch), so this is
  small — it is simply not part of these nine.
- **CI running tests.** 56 spec files, and neither workflow runs `npm test` or `lint`. Every spec
  here ships acceptance criteria that assume a suite someone runs.
