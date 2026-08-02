# SPEC — Supervisor scoping (per-salesman data isolation)

**Status:** draft, not started
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
  | { kind: 'REPS'; repIds: string[] };  // scoped user
```

`ScopeService.forCurrentUser(): Promise<Scope>`

Rules, in order:

1. `role === 'admin'` → `ALL`.
2. Has ≥1 row in `supervisor_reps` → `REPS` with those ids.
3. Otherwise → **`REPS` with an empty list**, i.e. sees nothing.

Rule 3 is the important one: **deny by default**. A user who should be scoped
but has no assignment yet sees an empty dashboard, never the whole company. The
opposite default is the kind of mistake that only surfaces after a leak.

Resolved once per request (interceptor → `UserContextService`, alongside the
existing user context), not per query, so a report touching six tables resolves
once.

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
| invoices | `invoice` | `user_code` |
| tax | `credit_note` | `user_code` |

Two link shapes exist — `rep_id` and `user_code`. The scope resolver must expose
**both** (`repIds` and the corresponding `userCodes`), resolved together, so a
query never has to join `reps` just to filter.

**Decision needed (Q2):** customers. Is a customer owned by a rep, or shared? If
a supervisor should see only their reps' customers, `customer.rep_id` scopes it —
but a customer served by two reps in different segments then appears for both.
Confirm the intent. See §11.

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

**Decision needed (Q3):** how much may a supervisor *do* versus *see*? Your
message said "just show … and approvals also", which reads two ways. Options:

- **A — read-only + approvals.** Sees everything for their reps, may approve
  their reps' requests, changes nothing else.
- **B — full admin within scope.** Everything the main admin can do, but only
  for their own reps: edit reps, set targets, assign routes, confirm collections.

B is what "make him admin on these salesmen" implies; A is what "just can show"
implies. This changes roughly half the work. See §11.

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

1. Migration + `ScopeService` + assignment API. No behaviour change.
2. Enforcement sweep, module by module, each with its two tests.
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
| **Q2** | Are customers rep-owned or shared? | Decides whether the customer list is scoped, and what happens to a customer served by two segments. |
| **Q3** | Read-only + approvals, or full admin within scope? | Roughly doubles the work if writes are included. |
| **Q4** | Should a supervisor see **aggregate** company figures (e.g. total sales) or only their slice? | Dashboard KPIs and reports differ; "their slice" is assumed here. |
| **Q5** | Unassigned reps — visible to main admin only, or to nobody until assigned? | Assumed main-admin-only. |

Q3 is the blocker; the rest can default to the assumptions stated above.
