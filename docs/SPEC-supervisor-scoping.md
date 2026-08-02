# SPEC — Supervisor scoping (per-salesman data isolation)

**Status:** phase 1 done. Phase 2 (enforcement sweep) **partially done** — 7 of
13 modules. **Do not create supervisor accounts yet**; see §9 for what is left.
**Repos:** `cash-van-dashboard` (backend), `cash-van-dashboard-frontend` (dashboard)
**Not affected:** FlowVan app, ERP

---

## 1. Problem

Today the dashboard is all-or-nothing: any user who can see the sales screens
sees *every* salesman. A company running 10 reps across three segments — malls,
supermarkets, government — has no way to give each segment's manager a login
that shows only their own people.

**Goal:** the main admin creates additional admins and assigns each a set of
salesmen. Those admins see the whole dashboard — transactions, stock, reports,
approvals, live map — but only ever for their own reps. The main admin continues
to see everything.

## 2. Non-goals

- Not a rewrite of the permission-key system (`vouchers.discount.direct` etc).
  Those gate *what a salesman may do in the app*; this spec gates *whose data a
  dashboard user may see*. The two are orthogonal and must not be merged.
- No change to the mobile app. A rep's own data access is unchanged.
- No change to the ERP. Export continues to push everything the van produces.
- No nesting: a supervisor cannot own another supervisor. One level only.

## 3. Terminology

| Term | Meaning |
|---|---|
| **Main admin** | `role = 'admin'`. Unscoped; sees and does everything. |
| **Supervisor** | A dashboard user with an assigned rep set. Sees only those reps. |
| **Scope** | The set of `rep.id` a request may touch, resolved per request. |

`supervisor` already exists in `UserRole` (`admin | manager | supervisor |
viewer`) but carries no data link today — the role is defined and unused for
scoping. This spec gives it meaning.

**Decision needed (Q1):** should scoping attach to the `supervisor` *role*, or
be an independent assignment that any non-admin role can carry? Attaching to the
role is simpler; independent assignment lets a `manager` also be scoped. See §11.

## 4. Data model

```sql
CREATE TABLE supervisor_reps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rep_id      uuid NOT NULL REFERENCES reps(id)  ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  CONSTRAINT uq_supervisor_rep UNIQUE (user_id, rep_id)
);
CREATE INDEX idx_supervisor_reps_user ON supervisor_reps (user_id);
```

A join table rather than a column on `reps`, because a rep may later need more
than one supervisor (cover, handover, regional + segment). Modelling it as
many-to-many now costs nothing and avoids a migration later.

`ON DELETE CASCADE` on both sides: deleting a user or a rep removes the
assignment rather than leaving a dangling scope that silently widens or narrows.

## 5. Scope resolution

One service, one method, one meaning. Everything else consumes it.

```ts
type Scope =
  | { kind: 'ALL' }                 // main admin — no filtering
  | { kind: 'REPS'; repIds: readonly string[]; userCodes: readonly string[] };
```

`ScopeService.forCurrentUser(): Promise<Scope>`

Rules, in order:

1. `role === 'admin'` → `ALL`.
2. Has ≥1 row in `supervisor_reps` → `REPS` with those ids.
3. Is themselves a rep → `REPS` with just their own id.
4. Otherwise → **`REPS` with an empty list**, i.e. sees nothing.

Rule 4 is the important one: **deny by default**. A user who should be scoped
but has no assignment yet sees an empty dashboard, never the whole company. The
opposite default is the kind of mistake that only surfaces after a leak.

Resolved once per request (memoised in CLS alongside the existing user context),
not per query, so a report touching six tables resolves once.

**Implemented:** `src/common/scope/` — `scope.types.ts` (the `Scope` union,
frozen `EMPTY_SCOPE`, `isUnscoped` / `isEmptyScope`), `scope.service.ts`
(`forCurrentUser()` memoised + `forUser(userId, role)` pure), `scope.module.ts`
(global, so no module can leak by forgetting to import it). Unit tests in
`scope.service.spec.ts` cover all four rules plus fail-closed and memoisation,
and `scope.util.spec.ts` covers the query helpers.

**Rule 3 was added during the sweep** (a user who *is* a rep resolves to their
own rep id). It is not a widening — it is what keeps the mobile app working.
A salesman's login is not an admin and has no assignment, so without it they
resolve to nothing and the app loses access to its own vouchers, stock and
collections. It is also strictly tighter than the status quo, where a rep's
token can read *any* rep's data through the dashboard endpoints.

**Consequence of the deny-by-default rule, to settle before finishing the sweep
(this is the real content of Q1):** today a `manager` or `viewer` sees every rep. Once enforcement lands they
resolve to the *empty* scope unless assigned, so those accounts go blank. Three
ways out, in order of preference:

1. Assign reps to every existing manager/viewer before flipping enforcement on
   — explicit, and forces someone to decide what each account should see.
2. Treat `manager` as unscoped like `admin` — one line in rule 1, but it means a
   manager keeps company-wide sight by default.
3. Grandfather existing accounts by seeding assignments in a migration.

Option 1 is the safe reading and the one this spec assumes. Whichever is chosen,
it must be decided *before* step 2 of §9, not discovered afterwards.

## 6. Enforcement

### 6.1 The surface

17 entities carry a rep or salesman link and therefore need filtering:

| Module | Entity | Link column |
|---|---|---|
| vouchers | `voucher_header` | `user_code` |
| sync | `voucher_inbox` | `user_code` |
| collections | `collection` | `rep_id` |
| products | `van_stock` | `rep_id` |
| reps | `rep_status`, `rep_location_event` | `rep_id` |
| reports | `salesman_settlement` | `rep_id` |
| routes | `route_plan`, `journey_plan_entry` | `rep_id` |
| targets | `sales_target` | `rep_id` |
| approvals | `approval_request` | `rep_id` |
| customers | `customer`, `customer_visit` | `rep_id` |
| cash-accounts | `cash_account`, `account_transaction` | `rep_id` |
| invoices | `invoice` | `rep_id` |
| tax | `credit_note` | `rep_id` |

Two link shapes exist — `rep_id` and `user_code`. The scope resolver must expose
**both** (`repIds` and the corresponding `userCodes`), resolved together, so a
query never has to join `reps` just to filter.

**DECIDED (Q2):** customers are **rep-owned**, so `customer.rep_id` scopes them:
a supervisor sees only their reps' customers. The main admin is unscoped and can
see and reassign any customer, including moving one between segments.

Consequence to handle: a customer whose `rep_id` changes moves between
supervisors, and their history moves with them — a supervisor loses sight of
past vouchers for a customer reassigned away. That is the correct reading of
"owned", but it means reassignment is a meaningful act and must be audited.

**Two further consequences, surfaced by implementing it — both need a decision
before step 4:**

1. A customer with `rep_id IS NULL` (house account, imported, not yet assigned)
   becomes visible to the **main admin only**. This is Q5 applied to customers.
   If the client has such customers, someone must assign them or accept that
   supervisors cannot see them.
2. A rep can no longer act on another rep's customer — including recording a
   visit. If reps in the field genuinely share customers (cover, holidays, a
   second van on the same street), this will read as a regression. Ownership by
   `rep_id` is what "owned" means, but it is stricter than how field teams often
   actually work, so it is worth checking against the client before flipping on.

The spec table above also had two entries wrong: `invoice` and `credit_note`
carry `rep_id`, not `user_code`. Corrected in the table.

### 6.2 How, not just where

Endpoint-by-endpoint filtering is the failure mode: one missed list and a
supervisor sees another segment, while the UI insists they can't. The rule is:

- Scoping applied in the **query layer**, via a shared helper
  (`applyScope(qb, scope, { repIdColumn })` / `scopeWhere(scope)`).
- A **default-deny test** per scoped module: a supervisor with an empty scope
  must receive zero rows from every list endpoint. New endpoints inherit it.
- A **cross-scope test** per module: supervisor A must not see supervisor B's rep.
- Single-record reads (`GET /vouchers/:id`) must 404 — not 403 — for out-of-scope
  ids, so the response doesn't confirm the record exists.

### 6.3 Writes

Reads are the bulk, but writes need the same check or a supervisor could approve
another segment's request by posting its id directly.

Scoped writes: approvals (approve/reject), voucher edits, target edits, route
assignment, rep edits, collection confirmation.

**DECIDED (Q3): option B — full admin within scope.** A supervisor may do
everything the main admin can, but only for their own reps: approve/reject their
requests, edit those reps, set their targets, assign their routes, confirm their
collections, edit their vouchers, and manage their customers.

This makes writes as security-critical as reads. Every scoped write must verify
the target's rep is in scope BEFORE mutating, and reject with 404 (not 403) for
an out-of-scope id — same reasoning as single-record reads.

Two write paths need particular care because the rep link is indirect:

- **Approvals** — the request's `rep_id` is the check, not the requesting user.
- **Vouchers** — `user_code`, not `rep_id`; resolve through the scope's
  `userCodes` set rather than joining.

A supervisor may NOT: create or delete dashboard users, assign reps to
supervisors, change company/ERP/tax settings, or act on an unassigned rep. Those
stay main-admin only — otherwise a supervisor could widen their own scope, which
defeats the feature.

## 7. Frontend

- **Assignment UI** — on the dashboard user drawer, a rep multi-select
  (searchable; the existing customer picker pattern). Visible to main admin only.
- **Scope indicator** — a persistent chip in the header: *"Viewing 3 of 10
  salesmen"*. Without it a supervisor cannot tell an empty list from a filtered
  one, and will report missing data as a bug.
- **Rep pickers** — every rep dropdown lists only in-scope reps.
- **Nav** — unchanged. Scoped users see the same screens with less data, rather
  than a different app.

The backend remains the authority. Frontend scoping is a convenience only: never
the enforcement.

## 8. Security requirements

1. **Deny by default.** Unknown or unresolved scope yields nothing.
2. **Fail closed.** If scope resolution throws, the request fails — it must not
   fall through to unscoped data. (This project has already been bitten by a
   swallowed error defaulting to a permissive path; see `18c4c92`.)
3. **No client-supplied scope.** Never read rep ids from query params to decide
   access — only from the resolved server-side scope.
4. **Audit.** Assignment changes write to the audit log: who assigned whom, when.
5. **JWT carries no scope.** Resolve per request from the DB, so revoking an
   assignment takes effect immediately rather than at next login.

## 9. Rollout

The migration is additive and safe on its own — an empty `supervisor_reps` means
every existing user resolves to `ALL` (admin) or is untouched.

Sequence:

1. ~~Migration + `ScopeService` + assignment API. No behaviour change.~~ **DONE.**
   `supervisor_reps` (migration `1722000000000`), `src/common/scope/`, and
   `PUT|GET /api/v1/users/:id/reps` (admin-only, audited by the global
   interceptor). Nothing consumes `Scope` yet, by design.
2. Enforcement sweep, module by module. **IN PROGRESS — 7 of 13.**

   | Module | Entry points scoped | Status |
   |---|---|---|
   | vouchers | `list`, `findOneOrThrow` (covers `update`/`remove`), `post`, `fulfill`, controller `create` | done |
   | reps | `list`, `findOne` (covers `update`/`kpis`), `softDelete` | done |
   | reps/locations | `list`, `visitsForRep`, `trackingSummary`, `latestPerRep` (live map) | done |
   | approvals | `list`, `findInScopeOrThrow` (covers `approve`/`reject`) | done |
   | targets | `list`, `upsert`, `remove` | done |
   | products/van-stock | `assertRep` (covers `forRep`/`load`/`return`) | done |
   | collections | `list`, `findOne` (covers `confirm`/`update`), `create`, `summary`, `batchDeposit` | done |
   | customers | `list`, `findOneOrThrow` (covers most), `reassign` (both ends) | done |
   | **invoices** | — | **TODO** |
   | **tax / credit-notes** | — | **TODO** |
   | **cash-accounts** | — | **TODO** |
   | **routes** (`route_plan`, `journey_plan_entry`) | — | **TODO** |
   | **sync** (`voucher_inbox`) | — | **TODO** |
   | **reports** | — | **TODO**, and blocked on Q4 |

   Not yet written: the per-module default-deny and cross-scope tests §6.2 calls
   for. `ScopeService` and `scope.util` have full unit coverage; the modules do
   not. Both must exist before step 4.

   Also unscoped and deliberately so — these are mobile intake paths that run
   under the salesman's own scope: `VouchersService.create` (gated at the
   dashboard controller instead), `LocationsService.record`/`recordBulk`,
   `ApprovalsService.findOneOrThrow`/`mine`/`cancel`,
   `RepsService.findByUserId`/`findByCode`, `TargetsService.getForRep`.

3. Frontend assignment UI + scope indicator.
4. Flip on: create the first supervisor, verify against a known rep set.

**Between steps 1 and 2 nothing is actually restricted.** Do not create
supervisor accounts until step 2 is complete for every module in §6.1 — a
half-swept build looks enforced and is not.

## 10. Testing

- Unit: `ScopeService` — admin → ALL; assigned → their ids; unassigned → empty.
- Per module: default-deny, cross-scope, and single-record 404.
- Integration: seed 2 supervisors × 3 reps, assert each sees only their own
  vouchers / collections / stock / approvals / reports.
- Regression: a main admin's result set is byte-identical before and after.

## 11. Open questions

| # | Question | Why it matters |
|---|---|---|
| **Q1** | Scope by `supervisor` role, or an independent assignment any role can carry? | Role-based is simpler; independent allows a scoped `manager`. |
| ~~Q2~~ | ~~Customers rep-owned or shared?~~ | **DECIDED: rep-owned; main admin can reassign. See §6.1.** |
| ~~Q3~~ | ~~Read-only or full admin within scope?~~ | **DECIDED: full admin within scope. See §6.3.** |
| **Q4** | Should a supervisor see **aggregate** company figures (e.g. total sales) or only their slice? | Dashboard KPIs and reports differ; "their slice" is assumed here. |
| **Q5** | Unassigned reps — visible to main admin only, or to nobody until assigned? | Assumed main-admin-only. |

Q2 and Q3 are decided. Q1, Q4 and Q5 stand on the assumptions above unless
contradicted — none of them blocks a start.

**Scope of work after these decisions:** writes are in, so the sweep covers both
directions and the estimate is the larger of the two options. The privilege
boundary above (a supervisor cannot manage users or assignments) is what keeps
"full admin within scope" from becoming "full admin".
