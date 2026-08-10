# Salesman-created customers: permission & approval

**Status: built and enforced end-to-end — except the switch that turns it on.**

The rule you asked for already exists in the backend, the mobile app and the
approvals screen. What is missing is one checkbox: the dashboard never exposes
`canCreateCustomerDirect`, so an admin cannot change it and **every salesman is
stuck on the default (must be approved)**. Closing that is a ~20-line change,
specified in §4.

---

## 1. The rule

Two independent questions, two flags. Both live on the user row.

| `canAddCustomer` | `canCreateCustomerDirect` | What happens when the salesman saves a customer |
|---|---|---|
| `false` | — | Refused. They cannot create customers at all. |
| `true` | `false` *(default)* | **Approval request.** Nothing is created; an admin reviews it. |
| `true` | `true` | **Customer created immediately.** |

Office users (no `repId`) bypass both: no photo requirement, no approval. The
gate is about field staff, not about the office.

### Why the default is "must approve"

A customer record is a credit relationship, not a contact card. Once it exists
it can be sold to on credit and counted against a limit. The safe default for a
new rep is that someone looks first; granting the direct flag is a deliberate
act per salesman.

### A note on naming

You described the switch as *"create customer must approve"* — checked means
approval is required. The shipped flag is the mirror image:
`canCreateCustomerDirect`, where **checked means no approval needed**.

Both express the same two states. Recommendation: **keep the positive flag and
label it positively** ("Create customers without approval"). Every one of the
nine sibling permissions reads "checked = this person may do more". A single
inverted checkbox in that list means checked = *less* allowed, and the one place
you do not want a misread is the switch that decides whether a credit
relationship goes unreviewed. The hint text under it can carry your wording
verbatim, which gets the clarity without the inversion.

If you would rather have the inverted checkbox, do it as a **display-only
inversion in the dashboard** (`checked={!perms.canCreateCustomerDirect}`) and
leave the stored flag alone — never invert the column, or every existing
salesman silently swaps behaviour on deploy.

---

## 2. What already exists

### Backend (`cash-van-dashboard`)

| Piece | Location |
|---|---|
| The flag | `users.can_create_customer_direct` — [user.entity.ts](../src/modules/users/entities/user.entity.ts) |
| Migration | [1722800000000-CustomerCreateApproval.ts](../src/database/migrations/1722800000000-CustomerCreateApproval.ts) |
| The branch | `createAsUser()` — [customers.service.ts](../src/modules/customers/customers.service.ts) |
| Request creation | `createCustomerRequest()` — [approvals.service.ts](../src/modules/approvals/approvals.service.ts) |
| Approve → creates customer | `decide()`, `CUSTOMER_CREATE` branch — same file |
| Accepted on user create/update | [create-user.dto.ts](../src/modules/users/dto/create-user.dto.ts) |
| Returned in the JWT/profile | [auth.service.ts](../src/modules/auth/auth.service.ts) |

Behaviour worth knowing:

- **A salesman must attach a document photo.** `createAsUser` rejects the
  request without `photoId`. The photo is staged in `pending_customer_photos`
  and only becomes a real customer attachment when the customer comes into
  existence — on direct create, or on approval.
- **A pending request creates nothing.** Deliberately not a disabled customer
  row: a half-real customer can be sold to and credit-checked before anyone has
  looked at it.
- **Approval failures are recorded, not half-applied.** If conditions changed
  since the request, `decide()` stores `failureReason` rather than leaving a
  partial write.
- Managers are notified when a request arrives.

### Mobile (`FlowVan`)

`POST /customers` answers one of two shapes, and
[CustomerApi.kt](../../FlowVan/core/network/src/commonMain/kotlin/com/jehadalomour/flowvan/core/network/api/CustomerApi.kt)
already reads both: the customer, or `{ pendingApprovalId, status: "pending" }`.

### Dashboard (`cash-van-dashboard-frontend`)

`ApprovalsView` renders `CUSTOMER_CREATE` requests and can approve/reject them,
including viewing the attached document photo.

---

## 3. The gap

`canCreateCustomerDirect` is **absent from the dashboard's permission UI**. It is
not in the `Permissions` type, not in `PERMISSION_FIELDS`, and not in the
salesman drawer's state — so it is never sent on save, and the column keeps its
`false` default forever.

Net effect today: **the approval flow is mandatory for every salesman**, with no
way to exempt anyone. Everything else works.

---

## 4. Implementation — closing the gap

All four edits are in `cash-van-dashboard-frontend`. No backend change: the DTO
already accepts the flag and the drawer already spreads `...perms` into the save
payload, so a new key is sent automatically once it exists in state.

**1. Add it to the type** — `src/lib/api/types.ts`, in `interface Permissions`:

```ts
  /**
   * May this salesman create a customer that is REAL immediately? Off routes
   * their creation through admin approval instead. Meaningless without
   * canAddCustomer, which decides whether they may create at all.
   */
  canCreateCustomerDirect?: boolean;
```

**2. Add the toggle** — `src/features/users/api.ts`, in `PERMISSION_FIELDS`,
directly after `canAddCustomer` so the two customer rules read together:

```ts
  { key: "canCreateCustomerDirect", label: "Create customers without approval" },
```

**3. Seed the drawer state** — `src/features/reps/SalesmanDrawer.tsx`, in
`EMPTY_PERMS`:

```ts
  canCreateCustomerDirect: false,
```

**4. Hydrate it when loading a salesman** — same file, in the block that maps
`user.data.*` into `perms`:

```ts
  canCreateCustomerDirect: !!user.data.canCreateCustomerDirect,
```

Then add the i18n label if the drawer localises `PERMISSION_FIELDS` labels
(today they are English literals shared with the users screen — match whatever
the sibling flags do rather than introducing a second convention).

### Optional polish, in priority order

- **Hint text under the toggle**, carrying your phrasing: *"Off = every customer
  this salesman adds waits for admin approval."* This is the single most
  valuable addition — it tells the admin what the unchecked state means, which
  is the state they are actually choosing by leaving it alone.
- **Grey it out when `canAddCustomer` is off**, since it is meaningless there.
  Disabled with a tooltip beats hidden: hidden invites "where did it go?".
- **Show the pending count** on the salesman row, so an admin can see they have
  left someone generating requests nobody is clearing.

---

## 5. Verifying it

1. Salesman with `canAddCustomer` and **without** the direct flag adds a
   customer in the app → response is `{ pendingApprovalId, status: "pending" }`,
   no customer row exists, request appears in **الموافقات** with the photo.
2. Admin approves → the customer now exists, the photo is attached to it, and
   the salesman's app reflects it on next refresh.
3. Admin rejects → still no customer; the salesman sees the rejection note.
4. Tick **Create customers without approval**, salesman signs in again *(the
   flag rides in the JWT, so it takes effect on their next login — not
   instantly)*, adds a customer → created immediately, no request raised.
5. Salesman without `canAddCustomer` → refused in both configurations.

Step 4's re-login caveat is worth telling the office: flipping the switch does
not change a salesman already signed in.

---

## 6. If you want it stricter later

The flag is per-salesman and binary. Two extensions that would not disturb the
above:

- **Threshold approval** — direct create allowed, but a credit limit above N
  still raises a request. Needs a rule on the amount, not just the actor.
- **Approver routing** — currently any admin/manager decides. A `CUSTOMER_CREATE`
  request could route to the rep's own supervisor via the existing rep-scope
  data, which already knows who supervises whom.
