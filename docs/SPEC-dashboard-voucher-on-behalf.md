# SPEC — Creating a voucher for a salesman from the dashboard

Two things at once, because they are the same question asked from two sides: **close** the path
by which any authenticated caller can post a document in another rep's name, and **open** a
deliberate, permissioned, audited way for an office user to raise a voucher on a salesman's
behalf.

Scope: `POST /v1/vouchers`, `POST /v1/sync/vouchers`, `POST /v1/sync/collections`,
`MobileContextGuard`, a new `vouchers.createOnBehalf` permission, the dashboard voucher form.
Companion: `SPEC-sync-intake-contract.md` §4.7, `SPEC-rep-scoped-users.md`,
`SPEC-supervisor-scoping.md`, `SPEC-discount-approval.md`.

---

## 1. What exists today (verified 2026-09-21)

### 1.1 The acting salesman comes from the request body

`CreateVoucherDto.userCode` is a required body field (`create-voucher.dto.ts:179`). The voucher's
`user_code` column is a FK to `users.user_number` (`voucher-header.entity.ts:26`), so whatever the
body says is who the document belongs to — and therefore whose van stock moves, whose settlement
it lands in, and whose commission it counts toward.

`SyncService` does the same: `resolveRepId(voucher.userCode)` (`sync.service.ts:53`) and
`repId: collection.repId` (`:99`).

Nothing compares any of this to the caller's token.

### 1.2 The sync routes have no authorization at all

`SyncController` (`sync.controller.ts:36`) is `@UseGuards(RolesGuard)` with **no `@Roles`** on the
two ingest methods. Both global guards are default-allow when their decorator is absent:

- `RolesGuard:34` — `if (!required || required.length === 0) return true; // No @Roles → open to
  any authenticated user.`
- `PermissionsGuard:36` — same shape.

So `POST /v1/sync/vouchers` is reachable by **any** valid token, and the document is attributed to
whatever `userCode` the body names. One rep can post a sale out of another rep's van, in that
rep's name, against that rep's stock and settlement.

### 1.3 The policy check runs against the wrong person

`enforceSalesmanPolicy` (`vouchers.service.ts:1763`) reads `this.userCtx.get()` — the **caller** —
and returns early for `admin`/`manager` (`:1766`). Combined with §1.1, the permissions that decide
whether a return may be filed, or a price undercut, are the *caller's*, never the salesman's whose
document it becomes.

For a manager acting deliberately that early return is reasonable. For a rep impersonating another
rep it is the exploit. The two cases are currently indistinguishable, because there is no notion of
"acting on behalf of" anywhere in the code.

### 1.4 `MobileContextGuard` drops its ownership check for repId-less callers

`mobile-context.guard.ts:82`:

    if (!privileged && tokenUser?.repId && tokenUser.repId !== rep.id) {
      throw new ForbiddenException('Salesman not authorized for this account');
    }

When `tokenUser.repId` is `undefined` the condition is false and **no check runs**. Any
non-privileged user with no linked rep — a `viewer`, a stock-manager account, a
supervisor whose rep link was removed — passes, and reads any salesman's van stock, customers,
prices and profile.

### 1.5 There is no audit distinction

`AuditInterceptor` records the mutating request with `entity` = the first path segment
(`audit.interceptor.ts:29`), so a voucher created by a manager for a rep and one created by the rep
look identical in `audit_log`. Nothing records "user X acted as rep Y".

---

## 2. What changes

| | today | after |
|---|---|---|
| `/sync/*` attribution | `userCode` from the body | **from the token; a mismatch is `403`** |
| `/sync/*` authorization | any authenticated user | **`@Roles('salesman','admin','manager')` + rep-bound** |
| `/vouchers` with another rep's `userCode` | allowed for anyone | **requires `vouchers.createOnBehalf`** |
| Who the policy applies to | the caller | **the target salesman**, with the caller's override recorded |
| Audit | indistinguishable | **`acted_as_rep_id` + `on_behalf` reason on the voucher and in `audit_log`** |
| `MobileContextGuard` repId-less caller | passes | **denied** |
| Dashboard | must send a `userCode` with no UI concept of it | **explicit "on behalf of" picker with the rules shown** |

The model, stated once: **a document has exactly one owner (the salesman) and optionally one
author (the office user who raised it). Today the two are conflated into one body field.**

---

## 3. Closing the hole: the handset

### 3.1 `/sync/*` derives the rep from the token

    @Post('vouchers')
    @Roles('salesman', 'admin', 'manager')
    ingestVoucher(@Body() dto: SyncVoucherDto, @CurrentUser() user: AuthenticatedUser) {
      return this.sync.ingestVoucher(dto, user);
    }

In `SyncService.ingestVoucher` / `ingestCollection`:

- resolve the acting rep from `user.repId`;
- if the body carries `userCode`/`repId` and it does **not** match, `403 REP_MISMATCH`. Do not
  silently overwrite it — a handset sending the wrong code is a bug worth surfacing, and a silent
  correction would post the document under a rep the app did not intend;
- if the body omits it, fill it from the token. New APKs can stop sending it;
- a caller with `role` `admin`/`manager` **and** the `vouchers.createOnBehalf` permission may name
  another rep — that is the office replaying a stuck document, and it follows §4 in full, including
  the audit fields;
- a caller with no `repId` and no privileged role is `403`. There is no third case.

### 3.2 `MobileContextGuard`

    - if (!privileged && tokenUser?.repId && tokenUser.repId !== rep.id) {
    + if (!privileged && tokenUser?.repId !== rep.id) {

which denies both the mismatch and the missing-`repId` case. Keep the message, and add a distinct
code so the two are distinguishable in support: `rep_mismatch` vs `no_rep_link`.

### 3.3 Default-deny is the real fix

§1.2 exists because a missing decorator means "allow". That is one forgotten decorator away from
happening again on the next controller. Flip it:

- `RolesGuard` and `PermissionsGuard` deny when neither a `@Roles`, `@RequirePermissions`, nor an
  explicit `@AnyAuthenticated()` decorator is present;
- add `@AnyAuthenticated()` to every route that is legitimately open to all logged-in users, as a
  statement rather than an omission.

This touches many controllers, so do it as its own change with its own review, and land it **after**
§3.1 — the specific hole is closed first, then the class of hole. An integration test asserting
that every non-`@Public` route carries one of the three decorators keeps it closed.

---

## 4. Opening the feature: voucher on behalf of a salesman

### 4.1 Who may do it

New permission key `vouchers.createOnBehalf`, in the catalog alongside the existing keys, granted
per user like the rest. `admin`/`manager` get it implicitly the way
`canApproveStockRequest` already does (`auth.service.ts:191`), because raising a document for a rep
is running the office.

Scope-bound: the target salesman must be within the caller's visible reps per
`RepScopeService` — a supervisor may act for their own reps and no others
(`SPEC-supervisor-scoping.md`).

### 4.2 The request

`CreateVoucherDto` gains two fields, and `userCode` keeps its meaning — **the salesman who owns
the document**:

    /** Required when userCode is not the caller's own rep. Free text, shown on the
     *  voucher and in the audit log. Not optional: an on-behalf document without a
     *  stated reason is the thing an auditor asks about six months later. */
    @IsOptional() @IsString() @Length(3, 200)
    onBehalfReason?: string;

    /** The van/store the goods move from. Defaults to the target salesman's van —
     *  never the caller's. */
    @IsOptional() @IsString()
    storeNumber?: string;

Server-side:

1. If `userCode` resolves to the caller's own rep → ordinary path, nothing changes.
2. Otherwise require `vouchers.createOnBehalf` + scope; `403` with
   `code: 'ON_BEHALF_NOT_ALLOWED'` when either fails.
3. Require `onBehalfReason`; `400` without it.
4. Stamp `acted_as_rep_id` = the target rep, `created_by_user_id` = the caller,
   `on_behalf_reason` on the header.

### 4.3 Which permissions apply — the decision that matters

`enforceSalesmanPolicy` currently applies the **caller's** flags. For an on-behalf document apply
**the target salesman's**, with one documented exception.

Reasoning: the document will sit in that salesman's settlement, count toward their commission, and
be answered for by them. If the office can raise a return the rep is not permitted to raise, the
rep's permission flags are decoration. So:

- **Stock, credit limit, proximity, tax, price floor** — evaluated for the target rep and its
  customer, exactly as if the rep had raised it. `proximity.enforce` is skipped when the request
  carries no `repLat/repLng`, which is already how a dashboard voucher behaves
  (`voucher-header.entity.ts:39` documents that a dashboard voucher has no rep position).
- **Return creation, discount, price override** — evaluated for the **target rep**. Where the rep
  would need approval, the caller may proceed *only* with their own explicit override permission
  (`vouchers.overrideSalesmanPolicy`), and the override is recorded on the header as
  `policy_overridden = true` plus which rule was overridden. An override that leaves no trace is
  the same as no rule.
- The existing early return at `:1766` for `admin`/`manager` is **removed** for on-behalf
  documents. It stays for a manager acting as themselves.

This is stricter than today. That is the point: today a manager silently bypasses every rep-level
rule, and nobody can tell afterwards which rules were bypassed or why.

### 4.4 Van stock still moves from the salesman's van

`resolveStore` (`sync.service.ts:271`) falls back to the rep's van store. For an on-behalf voucher
resolve it from the **target** rep, never the caller (who typically has no van at all). An explicit
`storeNumber` is honoured if the caller may draw on it.

Stock is deducted with the locking upsert from `SPEC-stock-write-integrity.md` §4.1, so an
on-behalf sale and the rep's own concurrent sale cannot both spend the same goods. This is not an
incidental dependency: an office user and a rep selling the same van at the same moment is exactly
the race that spec fixes, and it becomes routine the day this feature ships.

### 4.5 The ERP sees the salesman

The ERP export carries the salesman as the document's rep, unchanged — `reps.erp_account_code`
drives the credit side and must stay the owner's, or the settlement will not reconcile. The office
author is a VanFlow-side fact and is not exported.

### 4.6 Realtime and the handset

On a successful on-behalf voucher, emit `sync.required { resource: 'stock', reason:
'office_voucher' }` to `repRoom(targetRepId)` (`events.gateway.ts:18`) so the rep's van stock
corrects on their device instead of drifting until the next foreground pull. The rep also gets a
notification naming the document, its total and who raised it — a rep discovering an office-made
sale from their end-of-day shortfall is how trust in the system is lost.

---

## 5. Schema

`src/database/migrations/1727800000000-VoucherOnBehalf.ts`

    ALTER TABLE voucher_headers
      -- The office user who raised it. NULL = the owner raised it themselves,
      -- which is the normal case and must stay distinguishable from "unknown".
      ADD COLUMN created_by_user_id UUID REFERENCES users(id),
      ADD COLUMN on_behalf_reason   TEXT,
      ADD COLUMN policy_overridden  BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN policy_override_detail JSONB;

    CREATE INDEX idx_voucher_headers_created_by
      ON voucher_headers (created_by_user_id) WHERE created_by_user_id IS NOT NULL;

    ALTER TABLE collections
      ADD COLUMN created_by_user_id UUID REFERENCES users(id),
      ADD COLUMN on_behalf_reason   TEXT;

    -- Audit gains the same distinction, so "who acted as whom" is answerable
    -- without joining to the document.
    ALTER TABLE audit_log
      ADD COLUMN acted_as_rep_id UUID;

**No migration is needed for the permission keys.** There is no catalog table — granular keys are
plain strings in `users.permissions` (`text[]`), declared as constants beside the existing ones in
`vouchers.service.ts:122`–`:125` and surfaced through `AuthService.extractPermissions` +
`GET /v1/users/permissions`:

    // src/modules/vouchers/vouchers.service.ts, beside PERM_RETURN_CREATE / PERM_PRICE_OVERRIDE
    export const PERM_ON_BEHALF        = 'vouchers.createOnBehalf';
    export const PERM_POLICY_OVERRIDE  = 'vouchers.overrideSalesmanPolicy';

Both must be added to the dashboard's permission editor with Arabic and English labels
(«إنشاء فاتورة بالنيابة عن مندوب» / «تجاوز قيود المندوب عند الإنشاء بالنيابة»), and to `permKeys`
in the login + `/auth/me` payload so an installed APK can hide the affordance it cannot use — the
same reason the discount keys are still advertised after the server check was dropped
(`vouchers.service.ts:1806`).

---

## 6. Dashboard

On the voucher form, an **"على حساب مندوب / On behalf of"** picker, visible only with
`vouchers.createOnBehalf`, listing the caller's in-scope reps.

When a salesman is chosen, the form states the consequences rather than leaving them to be
discovered:

- the van the goods leave, with its current stock for each line as it is entered;
- that the sale counts toward that rep's settlement and commission;
- the reason field, required, with the submit button disabled until it is filled;
- any policy the target rep would have needed approval for, named inline, with the override
  checkbox — shown only with `vouchers.overrideSalesmanPolicy` and labelled with what is being
  overridden, not a bare "override".

On the voucher detail, list view and every settlement report, an on-behalf document is badged with
the author and the reason. `SPEC-end-of-day-report.md` should show the badge in the rep's own EOD
too — the rep is the first person who should know.

---

## 7. Acceptance

**The hole**

1. Rep A's token posts to `/sync/vouchers` with `userCode` = rep B. `403 REP_MISMATCH`. Nothing
   created.
2. A token with no `repId` and role `viewer` posts to `/sync/vouchers`. `403`.
3. Same token calls `GET /v1/mobile/van-stock?salesmanCode=<any>`. `403 no_rep_link`.
4. Rep A posts their own document with `userCode` omitted. It is attributed to rep A from the
   token.
5. After §3.3: a new controller route with no authorization decorator fails the test that asserts
   every route declares one.

**The feature**

6. A manager with `vouchers.createOnBehalf` creates a SALE for rep B with a reason. Voucher owner
   is rep B; `created_by_user_id` is the manager; `on_behalf_reason` stored; `audit_log` carries
   `acted_as_rep_id`.
7. Without the reason: `400`. Without the permission: `403 ON_BEHALF_NOT_ALLOWED`.
8. Out of scope: a supervisor acting for a rep outside their scope gets `403`.
9. Stock comes from rep B's van, and the van's quantity drops by the line quantity.
10. Rep B's handset receives `sync.required { resource: 'stock' }` and a notification.
11. Rep B lacks `vouchers.return.create`. A manager's on-behalf RETURN is refused — **unless** the
    manager holds `vouchers.overrideSalesmanPolicy`, in which case it posts with
    `policy_overridden = true` and the rule named in `policy_override_detail`.
12. The ERP export shows rep B as the document's salesman; the manager appears nowhere in it.
13. Concurrency: an on-behalf sale and rep B's own sale for the same item, posted simultaneously,
    both deduct — final van quantity is the sum of both, never one of them.

## 8. Rollout

1. **§3.1 and §3.2 first, on their own, immediately.** They are small, they close an active
   authorization hole, and they need none of the rest. Check the logs first for existing traffic
   where the body's `userCode` disagrees with the token's rep — if any exists, understand it before
   shipping a `403`.
2. Migration + §4 backend + §6 UI as one feature release.
3. §3.3 default-deny as its own change, with the route-coverage test.
4. §4.3's stricter policy evaluation is a **behaviour change for managers** who currently bypass
   every rep-level rule silently. Tell the owner before it ships, and ship it with the override
   permission already grantable, so nobody is blocked from work they were doing yesterday.
