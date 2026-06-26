# Spec — Salesman "request discount approval" permission + blocking flow

Status: **APPROVED — implementing** · Mirrors the existing return-approval blocking flow.

## Goal
A new salesman permission **"request admin to make discount on voucher"**. When enabled (and the salesman lacks direct-discount), if the salesman applies a discount — on a line **or** on the voucher total — saving the SALE is **blocked** until an admin approves the request (exactly like the return-approval flow). On approval the SALE is created and the salesman can print; on reject it's discarded.

## Permission model (mirrors returns)
- `vouchers.discount.direct` (existing) — apply discounts directly, no approval.
- **`vouchers.discount.approval` (NEW)** — may *enter* a discount, but it becomes a **request** the admin must approve.
- Neither → discount UI hidden; a discount is rejected outright.

## Existing infrastructure reused
- Approval entity already has type **`VOUCHER_DISCOUNT`**; `ApprovalsService.approve()` re-runs the stored `CreateVoucherDto` in the manager's context (creating the SALE) and notifies the salesman.
- Backend `enforceSalesmanPolicy` already throws `APPROVAL_REQUIRED:VOUCHER_DISCOUNT` when a discount is present and the salesman lacks `discount.direct`.
- App already has the blocking pattern for returns: `RequestReturnApprovalUseCase`, `PollApprovalUseCase`, `CancelApprovalUseCase`, `CommitApprovedReturnUseCase`, and the `VoucherViewModel` pending/poll/cancel UI + `ApprovalApi` (create/one/cancel). Dashboard `ApprovalsView` already renders `VOUCHER_DISCOUNT` requests (type, lines, requested discount).

## Changes

### Backend (cash-van) — make the permission meaningful
`vouchers.service.ts` `enforceSalesmanPolicy`, discount block:
- Add `PERM_DISCOUNT_APPROVAL = 'vouchers.discount.approval'`.
- When `totalDisc > 0` and `!has(PERM_DISCOUNT_DIRECT)`:
  - `has(PERM_DISCOUNT_APPROVAL)` → `throw 'APPROVAL_REQUIRED:VOUCHER_DISCOUNT'` (request flow).
  - else → `throw 'DISCOUNT_NOT_ALLOWED'` (cannot discount at all).
- The existing over-`discount.max` path for *direct* salesmen still routes to `APPROVAL_REQUIRED:VOUCHER_DISCOUNT`.

### Dashboard FE — expose the permission
- Add `vouchers.discount.approval` to `SALESMAN_PERM_KEYS` (SalesmanDrawer checklist) with a label (ar/en). No other dashboard change — `ApprovalsView` already shows discount requests + the realtime banner/badge cover it.

### App (FlowVan) — the blocking discount flow
New `DiscountApprovalUseCases.kt` (mirror of `ReturnApprovalUseCases.kt`):
- **`RequestDiscountApprovalUseCase`** — builds a transient **SALE** `InvoiceEntity` from the cart (line discounts) + voucher-level `discountAmount`, `toVoucherRequest(...).copy(voucherNumber=null, clientRef=unique)`, files `approvalApi.create(VOUCHER_DISCOUNT, payload, note, customerNumber)`, returns the request id. Nothing saved locally / no stock touched yet.
- **`CommitApprovedSaleUseCase`** — on approval, builds the SALE entity with `number = resultVoucher`, `status=CONFIRMED`, `syncedAt=now` (server already has it → no re-push), saves it, decrements van stock, and adds to customer balance when `paymentMethod=CREDIT` (mirrors `CreateSaleVoucherUseCase`, minus `syncNow`).
- Reuse `PollApprovalUseCase` + `CancelApprovalUseCase`.

`VoucherViewModel`:
- Init: `canRequestDiscount = session.can("vouchers.discount.approval")`.
- Inject `requestDiscountApproval` + `commitApprovedSale`.
- `save()` branch order: RETURN+`returnNeedsApproval` → return-approval (existing); **SALE + `needsDiscountApproval` → discount-approval (new)**; else normal sale/return/order.
- Generalize the existing poll: track `pendingKind` (RETURN | SALE_DISCOUNT); on **approved**, commit via the matching use case → set `savedId` → print. Reject → `errorAr`. Cancel → existing `cancelPendingApproval`.

`VoucherContract` (VoucherState):
- Add `canRequestDiscount: Boolean = false`.
- `hasDiscount: Boolean get() = cart.any { it.discountPct > 0 } || (voucherDiscountInput.toDoubleOrNull() ?: 0.0) > 0.0`.
- `needsDiscountApproval: Boolean get() = type==SALE && hasDiscount && !canDiscount && canRequestDiscount`.
- Discount inputs visible when `canDiscount || canRequestDiscount` (a `showDiscountInputs` flag the screen uses where it currently checks `canDiscount`).
- `saveLabelAr` (SALE): `needsDiscountApproval` → "طلب موافقة المدير على الخصم", else "حفظ الفاتورة".
- `isAwaitingApproval` already blocks `canSave` and drives the existing pending/cancel UI (reused unchanged).

`VoucherScreen`:
- Where discount UI is gated on `canDiscount`, use `showDiscountInputs` so an approval-only salesman can enter a discount.
- The existing pending banner ("بانتظار موافقة المدير…") + Cancel + auto-print-on-approve already cover this flow (it keys off `isAwaitingApproval`/`savedId`).

## Edge cases
- Salesman has `discount.direct` → no approval (direct), unchanged.
- Discount entered then removed before save → `needsDiscountApproval` false → normal save.
- Mixed: a SALE with discount AND needing price-override approval → backend throws the first gate hit; app files one request (discount). Price-override approval is a separate existing path; not combined here.
- Reject → discard (no local sale); Cancel → cancels the pending request, cart stays editable.
- Over-`discount.max` for a direct salesman still requires approval (existing behavior).

## Acceptance
- With `vouchers.discount.approval` ON + `discount.direct` OFF: entering any line/voucher discount changes Save to "request approval"; saving blocks (pending banner, can cancel) until the admin approves on the Approvals page; on approve the SALE is created (with the discount) and prints; on reject it's discarded.
- With neither key: discount UI hidden; a stray discount is rejected by the backend (`DISCOUNT_NOT_ALLOWED`).
- With `discount.direct`: unchanged (direct discount).
