# F10 — Approvals, Manager Notifications & Salesman Permissions

**Effort:** L (≈ 5–7 dev-days across the 3 repos) · **Build first** — F2/F3/F4/F5 publish into this bus.

## 1. Why (owner / sales-manager lens)

Three sensitive actions currently have no control point:

1. **Return vouchers** — a rep can return anything; returns are the classic shrinkage hole.
2. **Voucher discounts** — uncontrolled discounting silently erodes margin.
3. **Price changes on a line** — overriding the catalog price at sale time.

The fix is one mechanism, not three: a **per-salesman permission set** that either
*allows the action directly* or *converts it into an approval request* that the manager
decides from the dashboard in real time. Around it, a general **notification inbox**
(bell on the dashboard, push-style list on mobile) that every other feature reuses.

## 2. User stories

- As an **owner**, I set per salesman: can he create returns directly? what max discount %?
  can he change item prices? — from the rep/user edit screen.
- As a **salesman**, when I try an action I'm not allowed, the app doesn't block me with a
  dead end — it offers **"إرسال طلب موافقة" (send approval request)** with my proposed
  voucher attached, and shows me a pending banner until it's decided.
- As a **manager**, a bell badge appears instantly; I open the Approvals queue, see exactly
  what the rep proposed (lines, prices, discount, customer, his note), and approve or
  reject with a reason. On approve, the voucher is created/posted automatically.
- As a **salesman**, I get the decision on my phone within seconds (socket) or on next
  sync (offline), and the approved voucher is already in my list ready to print.

## 3. Permission model

### Keys (stored in `users.permissions` jsonb — column already exists, used by `PermissionsGuard`)

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `vouchers.return.direct` | bool | `false` | Create + post RETURN vouchers without approval |
| `vouchers.discount.direct` | bool | `false` | Apply voucher discount without approval |
| `vouchers.discount.maxPct` | number | `0` | Max discount % allowed directly (e.g. 5). Above it → approval even if `direct=true` |
| `vouchers.priceOverride` | bool | `false` | Change a line's unit price away from the catalog/quote price |

Notes:
- Admin/manager roles implicitly pass all checks (existing guard behavior).
- `maxPct` lets you express "small discounts free, big ones approved".
- Server is the source of truth: **`VouchersService.create` must enforce these** (reject or
  require an `approvalId`) — the mobile UI gating is convenience, not security.

### Where they're edited
Dashboard → Users table (Settings → المستخدمون) **and** the Rep drawer (`/reps`):
a "صلاحيات المندوب / Salesman permissions" card with three toggles + a max-% number input.
`PATCH /users/:id` already accepts partial updates; extend its DTO to whitelist these keys.

### How mobile learns them
`POST /auth/login` and `GET /auth/me` already return the user; ensure `permissions` is in
the payload (it's in the JWT claims per `AuthenticatedUser`). FlowVan stores them in
`SessionStore` (new `currentPermissions: String?` JSON) and exposes
`fun can(key: String): Boolean` used by the voucher screens.

## 4. Data model (backend)

### `approval_requests` (new)

```sql
CREATE TABLE approval_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL,              -- RETURN_VOUCHER | VOUCHER_DISCOUNT | PRICE_OVERRIDE
  status          text NOT NULL DEFAULT 'pending', -- pending | approved | rejected | cancelled
  requester_user  uuid NOT NULL,              -- users.id (the salesman)
  rep_id          uuid,                       -- reps.id when applicable
  customer_number text,
  payload         jsonb NOT NULL,             -- the full proposed CreateVoucherDto + context
  note            text,                       -- salesman's justification
  reviewer_user   uuid,                       -- who decided
  decision_note   text,
  result_voucher  text,                       -- voucher_number created on approve
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz
);
CREATE INDEX idx_approval_requests_status ON approval_requests (status, created_at DESC);
CREATE INDEX idx_approval_requests_requester ON approval_requests (requester_user, created_at DESC);
```

`payload` examples:
- `RETURN_VOUCHER`: the intended `CreateVoucherDto` (transKind RETURN, lines, reference voucher).
- `VOUCHER_DISCOUNT`: the SALE dto + `requestedDiscountPct` / `requestedDiscountValue`.
- `PRICE_OVERRIDE`: the SALE dto + per-line `{ itemNumber, catalogPrice, requestedPrice }`.

### `notifications` (new — generic inbox; F2–F5 also write here)

```sql
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid,            -- recipient; NULL = broadcast to managers/admins
  kind        text NOT NULL,   -- approval.requested | approval.decided | cheque.due | visit.unverified | trip.speeding | ...
  title_ar    text NOT NULL,
  title_en    text NOT NULL,
  body_ar     text,
  body_en     text,
  ref_type    text,            -- approval | cheque | visit | trip | voucher
  ref_id      text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications (user_id, read_at, created_at DESC);
```

## 5. API (backend, new `ApprovalsModule` + `NotificationsModule`)

| Method & path | Who | Purpose |
|---|---|---|
| `POST /approvals` | rep (authed) | Create request `{ type, payload, note, customerNumber }` → emits `approval.requested` |
| `GET /approvals?status=&type=&offset=&limit=` | manager+ | Queue (default `status=pending`) |
| `GET /approvals/mine?status=` | rep | The salesman's own requests (mobile polling fallback) |
| `POST /approvals/:id/approve` | manager+ | Decide → **executes** payload (creates/posts voucher via `VouchersService`), stores `result_voucher`, emits `approval.decided` |
| `POST /approvals/:id/reject` | manager+ | `{ reason }` → emits `approval.decided` |
| `GET /notifications?unread=&offset=&limit=` | any | Inbox (recipient = me, or manager broadcast if my role ≥ manager) |
| `POST /notifications/:id/read` · `POST /notifications/read-all` | any | Mark read |

**Execution on approve** runs in a transaction: re-validate stock/credit at decision time;
on conflict mark request `approved` but `result_voucher = null` + notify both sides of the
failure reason (don't silently half-apply).

**Realtime (`EventBridgeService` additions):**
- `approval.requested` → ws event `approval.requested` `{ id, type, rep_id, customer, total }` — dashboard bell + queue refresh.
- `approval.decided` → ws event `approval.decided` `{ id, status, result_voucher }` — mobile listens (FlowVan adds a lightweight Socket.IO client *or* polls `/approvals/mine` on a 30 s sync tick — polling is acceptable v1, reuse `SyncScheduler`).
- `notification.created` → ws `notification.created` for live bell badge.

**Enforcement in `VouchersService.create`:** if caller's permissions disallow the action and
no `approvalId` is attached → `403` with code `APPROVAL_REQUIRED` (mobile maps this to the
request-approval sheet). If `approvalId` present → verify it's `approved`, matches payload
hash, single-use.

## 6. Dashboard UI (`cash-van-dashboard-frontend`)

- **Bell** in `Topbar.tsx`: unread count badge (red), dropdown listing latest 10 from
  `GET /notifications` + live socket push; "عرض الكل" → `/approvals`.
- **New page `/approvals`** (nav group العمليات, icon `BadgeCheck`):
  - Tabs: بانتظار الموافقة / تمت الموافقة / مرفوضة.
  - Table: type pill (مرتجع / خصم / تغيير سعر), salesman, customer, total (mono JOD),
    requested discount/price delta, note, age. Row → drawer with a **diff view**
    (catalog price → requested price per line; original total → discounted total)
    + Approve / Reject buttons (reason required on reject).
- **Permission editor**: card in user edit drawer + rep drawer; 3 toggles + max-% input,
  gated `<Can role="admin">`. New i18n keys under `perm.*`, `approvals.*`, `notif.*`.

## 7. Mobile UI (FlowVan)

- `SessionStore.currentPermissions` + `PermissionChecker` in `core:domain`.
- **Sale screen**: discount field visible always, but on confirm: if pct > allowed →
  bottom sheet "هذا الخصم يتطلب موافقة المدير" with note field + **إرسال الطلب**.
  Price field per line: editable only with `vouchers.priceOverride`, otherwise tapping it
  offers the approval flow.
- **Return screen**: if `!vouchers.return.direct` the primary CTA becomes
  "إرسال طلب مرتجع" instead of "تأكيد المرتجع".
- **Requests inbox**: a small "طلباتي" section (Home or More tab) listing requests with
  status chips; pending ones show a clock. On `approved`, deep-link to the created voucher
  (synced down) for printing. Offline: requests queue in Room (`approval_requests_local`,
  synced=false) exactly like vouchers; `SyncRepository` pushes them.
- Decision delivery v1: poll `/approvals/mine?status=pending,decided-recently` inside the
  existing 60 s `SyncScheduler` tick; v2: Socket.IO client.

## 8. Acceptance criteria

1. Rep with all flags off: return/discount/price actions each produce an approval request,
   visible on the dashboard within 3 s (socket) — never a created voucher.
2. Manager approve → voucher exists, is posted, stock/debt updated, request shows
   `result_voucher`; rep sees the decision on next sync ≤ 60 s.
3. Manager reject with reason → rep sees the reason verbatim.
4. Rep with `discount.maxPct = 5`: 4% discount posts directly; 6% requires approval.
5. API-level bypass attempt (direct `POST /vouchers` with discount, no approvalId) → 403
   `APPROVAL_REQUIRED`.
6. Permission edits take effect on the rep's next login/`auth/me` refresh (document: JWT
   carries a permissions version `v` — bump invalidates old tokens, mechanism already exists).
7. Bell unread count accurate across reads/read-all; notifications list paginates.

## 9. Test plan

- Unit: permission resolution matrix (role × flags × pct); approve-executes transaction
  rollback on stock conflict; payload hash mismatch rejected.
- E2E (supertest): full request→approve→voucher chain; reject chain; bypass 403.
- Mobile: instrumented test for gated UI states; offline queue replay.

## 10. Out of scope (v1)

FCM/APNs real push (poll/socket suffice), multi-step approval chains, approval SLAs,
WhatsApp delivery of decisions.
