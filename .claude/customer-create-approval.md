# Salesman-created customers: permission & approval

**Status: complete.** The rule was already enforced in the backend, the mobile
app and the approvals screen; the switch that turns it on now exists too, in the
salesman drawer, as **«إضافة العميل تتطلب موافقة الإدارة»** — checked means the
salesman's customers wait for an admin, unchecked means they are created
directly.

That label is the inverted display §1 describes, chosen deliberately: it is how
the office asks the question. The stored column is untouched and still positive
(`can_create_customer_direct`), so nobody's behaviour changed on deploy.

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

### A note on naming — settled

You described the switch as *"create customer must approve"* — checked means
approval is required. The shipped flag is the mirror image:
`canCreateCustomerDirect`, where checked means no approval needed.

**Resolved in your favour, as a display-only inversion.** The checkbox reads
«إضافة العميل تتطلب موافقة الإدارة» and shows `!canCreateCustomerDirect`; the
column keeps its positive sense. That was the fallback this section recommended
for exactly this case, and it is the only safe way round: inverting the column
would have swapped the behaviour of every existing salesman the moment it
deployed.

The cost of the inversion is that one row in a list of nine reads "checked =
this person may do *less*". It is paid down by the hint underneath, which states
both states in words — *"المندوب يرسل العميل الجديد من التطبيق للمراجعة ولا
يُنشأ إلا بعد الموافقة. عند الإيقاف يضيفه مباشرة."* — so the meaning does not
rest on the reader inferring a polarity.

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
reads both: the customer, or `{ pendingApprovalId, status: "pending" }`. On the
pending shape the create screen stays put, polls the request, and shows the
decision — a rep sent back to a list with no idea whether the shop exists is a
rep who phones the office.

The screen also says so **before** the save, from
`SessionStore.canCreateCustomerDirect` (set at login and refreshed from
`/auth/me` on every catalog sync). Creating a customer means photographing a
document in front of the shopkeeper; learning only from the answer that the shop
is not open for business yet wastes the visit. The banner is advisory — the
server owns the decision and reports it either way, so a stale copy misleads for
one screen and can never create a customer that should have been reviewed.

### Dashboard (`cash-van-dashboard-frontend`)

`ApprovalsView` renders `CUSTOMER_CREATE` requests and can approve/reject them,
including viewing the attached document photo.

---

## 3. The gap — closed

`canCreateCustomerDirect` used to be absent from the dashboard's permission UI:
not in the `Permissions` type, not in `PERMISSION_FIELDS`, not in the salesman
drawer's state — so it was never sent on save and the column kept its `false`
default forever. **The approval flow was mandatory for every salesman with no
way to exempt anyone.** Everything else already worked.

---

## 4. Implementation — what shipped

All of it in `cash-van-dashboard-frontend`. No backend change was needed: the DTO
already accepted the flag and the drawer already spreads `...perms` into the save
payload, so the new key rides along once it exists in state.

| Edit | File |
|---|---|
| The flag, with the inversion documented on it | `src/lib/api/types.ts` → `interface Permissions` |
| The toggle, right after `canAddCustomer` | `src/features/users/api.ts` → `PERMISSION_FIELDS` |
| Default for a new salesman (`false` = needs approval) | `src/features/reps/SalesmanDrawer.tsx` → `EMPTY_PERMS` |
| Hydrate from `GET /users/:id` | same file, the `setPerms` block |
| `ar`/`en` label + hint | `src/lib/i18n/dictionaries.ts` → `perm.*` |

`PERMISSION_FIELDS` entries gained three optional properties rather than growing
a second list beside them:

- `labelKey` / `hintKey` — dictionary keys. All ten rows were English literals in
  an Arabic-first UI, the only strings in the drawer that skipped the dictionary;
  adding a tenth in Arabic beside nine in English would have looked broken, so
  they were all moved over.
- `invert` — display the opposite of the stored flag. One row uses it.
- `needs` — name a flag this one is meaningless without, so the drawer greys it
  out. The approval toggle `needs: "canAddCustomer"`.

### Still open, in priority order

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
4. **Untick** «إضافة العميل تتطلب موافقة الإدارة» and the salesman's *next*
   customer is created immediately, with no request raised — no re-login.
5. Salesman without `canAddCustomer` → refused in both configurations.

**Step 4 used to carry a re-login caveat, and no longer does.** `createAsUser`
read the flag off the JWT claim, so flipping the switch changed nothing until the
salesman signed out and back in — which on a field phone can be days. It now
reads the column fresh on each create. That costs one indexed lookup on an
operation that already uploads a photo, and it is what makes the switch behave
the way the office expects: flip it, and the next customer obeys.

The dashboard half of this was verified on the running stack: opening a salesman
shows the box ticked while `can_create_customer_direct` is `false`; unticking and
saving flips the column to `true`; reopening hydrates unticked; re-ticking and
saving returns it to `false`. With `canAddCustomer` off the row greys out and
reads «يتطلب تفعيل «إضافة العملاء» أولًا».

---

## 6. If you want it stricter later

The flag is per-salesman and binary. Two extensions that would not disturb the
above:

- **Threshold approval** — direct create allowed, but a credit limit above N
  still raises a request. Needs a rule on the amount, not just the actor.
- **Approver routing** — currently any admin/manager decides. A `CUSTOMER_CREATE`
  request could route to the rep's own supervisor via the existing rep-scope
  data, which already knows who supervises whom.
