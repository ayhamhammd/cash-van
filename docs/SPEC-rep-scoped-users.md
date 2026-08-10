# SPEC — Rep-scoped dashboard users

## The problem

Today every dashboard user with `admin` or `manager` role sees **every** salesman:
all reports, the whole live map, the full approvals queue, every settlement.

The business has supervisors who own a *subset* of the field force — two admins,
four salesmen, two each. A supervisor must see their own salesmen and nothing
else: their reports, their approvals, their tracking, their settlements, their
dashboard KPIs.

## The model

Two new pieces of state on the user:

| | |
|---|---|
| `users.rep_scope_mode` | `'all'` (default) or `'assigned'` |
| `user_rep_scope(user_id, rep_id)` | which reps an `'assigned'` user may see |

**Why a mode flag rather than "empty scope = sees everything":** that rule makes
forgetting to assign reps silently grant full access. With an explicit mode, a
scoped user with zero reps assigned sees *nothing* — wrong, but visibly and
safely wrong. Fail closed.

**Why a join table rather than `reps.supervisor_user_id`:** reassignment is a
supervisor-side edit ("give Ahmad these two"), not a rep-side one, and a rep may
need to be visible to a regional manager *and* their direct supervisor. The
unique index on `(user_id, rep_id)` keeps it honest.

Existing users default to `'all'`, so nothing changes until someone is
deliberately scoped.

## Resolution

One service answers one question:

```ts
RepScopeService.visibleRepIds(user): Promise<string[] | null>
//   null      → unrestricted (rep_scope_mode = 'all')
//   string[]  → exactly these rep ids (possibly empty)
```

Call sites treat `null` as "no filter" and an array as `IN (:...ids)`. An empty
array must produce an empty result, never an unfiltered one — the single most
likely bug in this feature, and the reason `visibleRepIds` returns `null` rather
than an empty array for the unrestricted case.

A rep user (`repId != null`) is always scoped to themselves regardless of mode;
that already holds today via `me`-prefixed endpoints and is not changed here.

## Enforcement points

Ordered by what the request named. Each is "filter, not forbid" unless noted.
All of the below are **implemented**.

| Area | Endpoint | Rule |
|---|---|---|
| Dashboard | `GET reports/dashboard` | KPIs aggregate only visible reps |
| Dashboard | `GET reports/sales-trend`, `top-customers`, `best-items` | same |
| Reports | `GET reports/rep-leaderboard`, `rep-trips`, `voucher-summary` | same |
| Reports | `GET reports/visits`, `visits-no-transaction` | same |
| Settlement | `GET reports/end-of-day`, `end-of-day/settlements` | same |
| Settlement | `POST reports/end-of-day/settle` | **403** when the rep is out of scope — this one writes |
| Settlement | `GET reports/eod-lock/:repId` | **403** when out of scope; a salesman's own scope is themselves, so the mobile app is unaffected |
| Approvals | `GET approvals` | only requests whose `rep_id` is visible |
| Approvals | `POST approvals/:id/approve` / `reject` | **403** when out of scope |
| Customers | `GET customers` | only customers whose `rep_id` is visible |
| Sales | `GET vouchers` | scoped by WHO MADE the voucher — `user_code` → `users.user_number` → `reps.user_id` |
| Targets | `GET targets` | only visible reps' targets and actuals |
| Receivables | `GET ar/aging`, `ar/receivables` | filtered after the ERP enrichment, where the rep assignment first exists |
| Receivables | `GET ar/arrears-summary` | credit-sold by the voucher's rep, collected by the collector, receivable + arrears by the customer's rep |
| Collections | `GET collections`, `collections/summary` | only collections whose `rep_id` is visible |
| Collections | `GET collections/aging` | cheques scoped through the collection that banked them — a cheque carries no rep of its own |
| Tax | `GET tax/report`, `tax/ledger`, `tax/report/export` | ledger entries scoped via `document_id` → `invoices.rep_id` (SALE) or `credit_notes.rep_id` (RETURN) |
| Stores | `GET warehouses` | depots always; VAN stores only for visible reps — this one list feeds every store dropdown in the app |
| Stores | `GET warehouses/:id` | **403** when the store is a van outside scope |
| Tracking | `GET reps` | list filtered |
| Tracking | `GET reps/:id`, `:id/kpis` | **403** when out of scope |
| Tracking | `:id/locations`, `:id/visits`, `:id/sale-points`, `:id/tracking-summary`, `:id/locations.geojson` | **403** when out of scope |
| Tracking | `GET reps/locations/latest` (live map) | filtered |
| Realtime | `/ws/ops` rep-scoped events | routed to watcher rooms — see below |

Two notes on shape:

**Customer scope stacks on top of the existing `repId` filter, it does not
replace it.** The list already lets you narrow to one salesman; if scope replaced
that filter, a scoped user could widen past their assignment by sending someone
else's `repId`.

**Per-rep tracking is a 403, not an empty result.** An empty GPS trail reads as
"this salesman didn't move today" — a different and misleading statement from
"not yours". `locations.geojson` is guarded for the same reason as the trail it
exports, or the export becomes a way around the guard.

**A filter over unscoped data is decoration.** Every salesman dropdown in the
dashboard is fed by `GET reps`, so a scoped supervisor has only ever been
offered their own people. That is why the gaps above were easy to miss: the
control looked right while the rows underneath it were everyone's. Granting
someone a report answers "may they open it"; scope answers "whose numbers are
in it", and both have to be asked.

**The scoped tax report is a slice, not the filing.** `tax/report` under scope
sums one supervisor's salesmen; only an unscoped user sees the number that goes
to the ISTD. The XLSX export is scoped identically — otherwise the download is
the way round the screen.

**A van store is a salesman; a depot is not.** Van stores are created with a
salesman, named after them and hold their stock, so they follow the salesman's
scope — which is why a scoped supervisor's store dropdowns stop listing other
people's vans. Depots (`is_van = false`) belong to nobody and stay visible to
everyone: stock still has to move out of one and purchases still land in one, so
hiding them would break transfers rather than protect anything. A van with no
salesman assigned is nobody's, and under scope that means not yours.

**Sign-out drops the whole query cache** (`qc.clear()` in the topbar). Once every
list is scoped to who asked for it, cache keys that name only the resource are
no longer unique per viewer — without the clear, the next person to sign in on
that tab is served the previous one's rows until they go stale, and warehouses
hold for five minutes.

## Realtime

Dashboard sockets join **watcher rooms** at handshake:

    unrestricted →  scope:all
    assigned     →  watch:<repId>  for each assignment

Distinct from the existing `rep:<id>` rooms, which are the *salesman's own
device*; these are *who may watch that salesman*. A salesman's socket joins
`watch:<their own id>`, so they see only themselves.

Every event naming a rep — `rep.location`, `rep.online` / `offline` / `gps_on` /
`gps_off` / `app_closed`, `invoice.created` / `confirmed`, `route.deviated`,
`anomaly.flagged`, `approval.requested` / `decided` — goes through
`broadcastForRep`, which emits to `scope:all` plus that rep's watcher room.
Genuinely global events (`notification.created`, `cheque.scanned`) still
broadcast to every socket.

Rooms rather than filtering at emit time: emit stays O(1) instead of walking
every connected socket per ping, and the membership is decided once, in the one
place that already reads the JWT.

Two failure modes, both closed:

- an event with **no resolvable repId** goes to `scope:all` only — an approval
  filed from the office has no rep, and that is exactly the event no scoped
  supervisor should be pinged about
- a **failed scope lookup** joins no room at all

## Known limitations

**Socket scope is resolved once at handshake.** Widening someone's assignment
takes effect on their next connection (a page refresh), not mid-session. Worth
knowing when you add a salesman to a supervisor and they report the live map
still looks wrong.

**There is a few-millisecond window at connect** where a scoped socket is in no
watcher room and misses events. `handleConnection` cannot await the database
lookup — Socket.IO does not gate delivery on it. Missing one live ping is the
safe failure; receiving another supervisor's would not be.

**`reports/low-stock` and the dashboard's low-stock count stay company-wide.**
`item_balance` has no rep dimension — stock sits in a warehouse by
`stock_number` with no mapping back to a salesman. A reorder warning for the
whole business is correct, not a leak.

**Cheques are scoped through the customer.** `payment_cheques` carries no
`rep_id`; the owning salesman is a property of the customer the cheque came from.

**Settlement history stacks scope on top of `repId`,** the same way the customer
list does, and for the same reason.

## Admin UI

The dashboard user drawer carries a **salesmen** section: an all/assigned toggle
and, when assigned, a checkbox list of salesmen. Choosing "assigned" with none
selected is allowed but warned about, since it produces a user who can log in and
see nothing.

The drawer prefills from `GET /users/:id`, which is the only endpoint that
returns `repIds` — the list omits it, since filling a join-table column per row
costs a query each for something no list renders. Prefilling matters more than it
looks: without it, opening a scoped supervisor and saving an unrelated field
would post `repIds: []` and wipe their whole assignment.

## Status

All five phases are implemented and verified against a live scoped user:

1. **Schema + resolver** — migration, entity, `RepScopeService`, users API accepts `repIds`
2. **Read filtering** — dashboard KPIs, all reports, approvals, customers, reps, live map
3. **Write guards** — settle, eod-lock, approve/reject, rep detail + tracking history
4. **Dashboard UI** — salesmen picker on the user drawer
5. **Realtime** — watcher rooms on the ops gateway

Verified end to end with a supervisor assigned one of three reps: dashboard KPIs,
sales-trend, top-customers and rep-leaderboard all returned smaller figures than
the admin's; every per-rep tracking endpoint returned 403 for an unassigned rep
and 200 for an assigned one; and two concurrent sockets showed the admin
receiving both reps' pings while the scoped user received only their own.
Emptying the assignment zeroed every figure and silenced the socket entirely.
