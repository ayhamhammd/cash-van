# SPEC — Export cash sales to the ERP as *paid*, not credit

**Status:** implemented (Phase 1 + Phase 2)
**Scope:** CashVan backend only (`erp-sync` outbox). **No ERP change required.**
**Owner:** —
**Related:** [[erp-integration]], [[erp-stock-movements-sync-gotchas]], AR reconciliation (`docs/SPEC-ar-collection-reconciliation.md`)

---

## 1. Problem

When a van SALE is exported from CashVan to the ERP, the ERP **always books it as an
on‑account (credit) sale**, even when the salesman was paid **cash** (or cheque/card/
transfer) at the point of sale.

Consequences:
- The customer's ERP receivable (ذمم) is inflated by cash that was actually collected.
- Cash sales wrongly **consume the customer's credit limit** and can trip the hard
  credit block.
- No `RECEIPT_VOUCHER` / cash‑receipt is posted, so the GL shows a debtor instead of cash.

## 2. Root cause

CashVan's outbox builds the sales‑invoice payload **without any payment fields**:

`src/modules/erp-sync/erp-outbox.service.ts` → `buildSale()` (~line 359) sends only:
```
{ externalId, deviceId, <customerRef>, warehouseCode, invoiceDate, items }
```

The ERP decides credit-vs-cash like this
(`ERP/src/app/api/v1/sales-invoices/route.ts:430`):
```ts
const isCreditSale = d.paymentType ? d.paymentType === "CREDIT" : !d.paymentMethod;
```
Because CashVan sends **neither `paymentType` nor `paymentMethod`**, `isCreditSale` is
always `true` → every sale is on‑account.

## 3. The ERP already supports the fix (no ERP change)

`POST /api/v1/sales-invoices` accepts (route.ts:188‑191):
```ts
paymentMethod: z.enum(["CASH", "CARD", "BANK_TRANSFER", "CHECK"]).optional();
paymentType:   z.enum(["CASH", "CREDIT"]).optional();
```

When `paymentMethod` is present, the invoice handler (route.ts:622‑686) — in the **same
atomic transaction** — automatically:
1. inserts an `invoicePayments` row for the **full invoice total** (`amount: totalAmount`, line 630),
2. sets `invoices.amountPaid = total`, `status = "paid"` (deriveStatus),
3. posts a `RECEIPT_VOUCHER` GL journal if auto‑posting is on (savepoint‑isolated; a bad
   template skips the journal, never fails the sale),
4. writes a `cash_receipt` row into `financialTransactions`,
5. sets `isCreditSale = false` → does **not** consume the credit limit.

So a cash sale is fully settled by the single sales‑invoice call. **We do not need a
separate `/api/v1/receipts` call for point‑of‑sale cash.** (Receipts remain for *later*
collections against previously-credited invoices — the existing `buildPayment` path.)

## 4. CashVan has the classification already

A voucher is created as *header + lines + payments[]* atomically
(`vouchers.controller.ts:77`). Each payment row (`payments` table / `Payment` entity) has:
- `payment_type` ∈ `CASH | CHEQUE | TRANSFER | CARD | CREDIT`
- `amount` (numeric)

A sale may have **one** payment (the common case) or **several** (split payment).

## 5. Design

### 5.1 Mapping (CashVan `payment_type` → ERP `paymentMethod`)

| CashVan `payment_type` | ERP `paymentMethod` | Meaning to ERP |
|---|---|---|
| `CASH`     | `CASH`          | paid, invoice settled |
| `CHEQUE`   | `CHECK`         | paid by cheque, invoice settled |
| `CARD`     | `CARD`          | paid, invoice settled |
| `TRANSFER` | `BANK_TRANSFER` | paid, invoice settled |
| `CREDIT`   | *(omit)*        | on‑account; send `paymentType: "CREDIT"` |

### 5.2 Rule in `buildSale`

Load the voucher's `payments[]` and classify:

```
paidRows   = payments.filter(p => p.paymentType !== 'CREDIT')
paidAmount = sum(paidRows.amount)
netTotal   = header.netTotal        // the payable total

if paidRows.length > 0 AND paidAmount + EPS >= netTotal:
    # fully paid at point of sale (single or homogeneous method)
    method = mapMethod(dominantType(paidRows))   # the type with the largest paid amount
    body.paymentMethod = method
    body.paymentType   = 'CASH'      # explicit; helps JoFotara + is unambiguous
else:
    # credit sale, or no payment captured
    body.paymentType   = 'CREDIT'    # (paymentMethod omitted)
```

- `EPS` = a small rounding tolerance (e.g. `0.005` JOD) to absorb fils rounding.
- `dominantType` picks the payment method carrying the most value when a fully‑paid sale
  used more than one non‑credit method (ERP records ONE method for the full total).

### 5.3 Partial / split payment (part cash + part credit) — **Phase 2, implemented**

The ERP's inline invoice payment is **all‑or‑nothing** (it always pays the full total,
route.ts:630). So a split sale is handled in two steps:
1. The `SALE_INVOICE` is pushed as **credit** (`paymentType: 'CREDIT'`, no `paymentMethod`)
   — `splitPaidPortion()` returns non‑null for a split, and `salePaymentFields()` returns
   `CREDIT` whenever a `CREDIT` row is present.
2. **After** the invoice posts and `mapVoucher` records its ERP invoice number,
   `pushOne` enqueues a new `SALE_SPLIT_RECEIPT` outbox row for the voucher. Its builder
   (`buildSplitReceipt`) posts `POST /api/v1/receipts` for the **paid portion**, allocated
   to that `invoiceNumber` (ERP `receipts/route.ts:118`), with `externalId = <voucher>-PAY`
   and its **own** idempotency key so it never replays as the sale.

Ordering is guaranteed because the receipt row is only enqueued once the invoice exists
and is id‑mapped. If the invoice number isn't resolvable yet, the receipt omits
`invoiceNumber` and the ERP FIFO‑allocates on‑account (fallback).

> **Known limitation:** the invoice's ERP credit‑limit check runs on the **full total**
> (the sale is booked as credit), even though part was paid cash. A split sale can
> therefore be blocked by `CREDIT_LIMIT_EXCEEDED` when the full total exceeds available
> credit. The end state (receivable = unpaid remainder) is correct once the receipt lands.
> Lifting this needs an ERP change (accept a partial `amountPaid` on the invoice) — out of
> scope here.

## 6. Implementation steps (Phase 1)

1. **Inject the Payment repo** into `ErpOutboxService`
   (`@InjectRepository(Payment)`; `Payment` is already exported by `VouchersModule`, so
   import that repo/feature into `ErpSyncModule` or add `TypeOrmModule.forFeature([Payment])`).
2. **In `buildSale`** (`erp-outbox.service.ts` ~359): after loading `header`/`lines`,
   load `payments` by `voucherNumber`, compute the classification in §5.2, and add
   `paymentMethod` / `paymentType` to `body`.
3. Add a small private helper `mapPaymentMethod(type: PaymentType): string | null` and
   `classifySalePayment(payments, netTotal)`.
4. Leave `buildReturn`, `buildOrder`, `buildAdjustment`, `buildPayment` unchanged.

### Payload after the change (cash sale)
```jsonc
{
  "externalId": "S-000123",
  "deviceId": "U-0007",
  "customerCode": "C-0001",
  "warehouseCode": "VAN-01",
  "invoiceDate": "2026-07-11T10:00:00Z",
  "paymentMethod": "CASH",
  "paymentType": "CASH",
  "items": [ /* … */ ]
}
```

## 7. Idempotency & back‑fill of already-exported sales

- Pushes are idempotent on `externalId` (409 `DUPLICATE_EXTERNAL_ID` → treated as success).
- **Consequence:** sales already exported as *credit* will **not** flip to *paid* on a
  re-push — the ERP invoice already exists. Options for historical rows:
  1. Leave them; only new sales are corrected (simplest), **or**
  2. For each mis-booked cash invoice, post a compensating **receipt**
     (`POST /api/v1/receipts`, allocated to that `invoiceNumber`) to settle it — a
     one-off back-fill script using the existing receipt path.
- Choose (1) for go-live unless finance needs the historical cash settled in the ERP.

## 8. Edge cases / decisions

- **Cheque handling:** `CHECK` marks the invoice **paid immediately** in the ERP. If the
  business wants post‑dated cheques held until they clear, treat `CHEQUE` as **credit**
  and settle via a cheque collection later. Make this a settings toggle
  (`erpTreatChequeAsPaid`, default **true**) — mirrors how `buildPayment` already maps
  cheque→`CHECK`.
- **Zero‑value / fully‑discounted sale:** `netTotal <= 0` → send as `CASH` (nothing owed).
- **No `payments[]` rows at all:** treat as **credit** (current behaviour) — safe default.
- **Credit sales:** unchanged in outcome, but now send an explicit `paymentType: 'CREDIT'`
  for clarity and correct JoFotara payment typing.

## 9. Testing / acceptance

Post a sale each way and verify on the ERP (`GET /api/v1/sales-invoices/{id}` or the ERP UI):

| Scenario | Expected ERP invoice |
|---|---|
| CASH sale | `status = "paid"`, `amountPaid = total`, `amountDue = 0`, a `RECEIPT_VOUCHER` journal + `cash_receipt` exist, credit limit **not** consumed |
| CHEQUE sale (toggle on) | as above, `paymentMethod = check` |
| CREDIT sale | `status = "issued"`, `amountDue = total`, credit limit consumed |
| Split (Phase 2) | invoice credit + a receipt for the paid part; `amountDue = unpaid remainder` |

Add a unit test on `buildSale` asserting the body carries the right
`paymentMethod`/`paymentType` for each `payments[]` shape.

## 10. Files to touch (Phase 1)

- `src/modules/erp-sync/erp-outbox.service.ts` — `buildSale` + helpers, inject `Payment` repo.
- `src/modules/erp-sync/erp-sync.module.ts` — register the `Payment` repo if not visible.
- `src/modules/erp-sync/__tests__/erp-outbox.buildSale.spec.ts` — new unit test.
- (Phase 2) split-payment receipt companion in the outbox.
- **ERP:** none.

---

## 11. Addendum — ERP posting-variant changes (ec9bfea, 3f47ac6, 668a94d)

The ERP now picks a **posting variant** per invoice instead of always debiting
A/R and then clearing it with a second journal.

### Why this spec still holds

The variant is chosen from `paymentType` + `paymentMethod` — and crucially,
**`paymentType: "CASH"` alone is read as a CREDIT sale**; a payment method must
also be present. `salePaymentFields()` has always emitted the two together for
fully-paid sales (§5), so van cash sales pick up the new single journal:

```
DR  <payment method account>   total     ← was: DR A/R, then a second journal
CR  Sales Revenue              net
CR  Tax Payable                tax
```

Split sales are unaffected: the invoice still goes as `CREDIT` and the paid part
is settled by the companion `/receipts` push, which still posts DR bank / CR A/R
— correct, because there is a real receivable to clear.

### The failure mode this addendum exists for

The ERP wraps journal posting in a savepoint. If the org has no payment-method
account mapped, it logs `PAYMENT_METHOD_ACCOUNT_NOT_CONFIGURED`, **skips the
journal, and still returns 201** with the invoice, stock movements and payment
row all committed. `journalId` comes back `null`.

That is not retryable and must never be re-pushed — a retry would duplicate the
invoice if `externalId` idempotency ever lapsed. It is also invisible: the push
succeeds, the outbox row reads `posted`, and the sale simply never reaches the
general ledger.

So `erp_outbox` now records the outcome:

| Column | Meaning |
|---|---|
| `journal_id` | ERP GL entry. `NULL` on a posted SALE_INVOICE = journal skipped. |
| `payment_skipped` | ERP refused the inline payment (approval workflow) and booked the sale as credit. Cash was collected in the van but is not in the ERP books. |

`warnOnPostingGap()` logs a warning for each case at push time. It fires **only**
for `SALE_INVOICE`, because `journalId` is documented on that response alone — a
missing value on `/receipts` or a sales return proves nothing (sales returns post
no journal at all).

### Finding affected sales

```sql
SELECT ref, result_ref, created_at
FROM erp_outbox
WHERE kind = 'SALE_INVOICE'
  AND status = 'posted'
  AND journal_id IS NULL
  AND created_at >= '<date this migration was deployed>'
ORDER BY created_at DESC;
```

The `created_at` bound is not optional: rows pushed **before** the migration also
have `journal_id IS NULL` simply because the field wasn't captured then, and are
indistinguishable from genuinely unposted ones. The partial index
`idx_erp_outbox_unposted_journal` is keyed on `created_at` for exactly this.

A non-empty result is an **ERP configuration** task (Settings → Finance →
Payment Method Accounts), not a re-push.

### Not adopted

`4004 Sales Discount` / `4005 Purchase Discount`: the ERP can now book line
discounts to their own account. This is opt-in per organisation and needs no
change here — we already send per-line `discount`, and `totalDiscount` in the
response is unchanged either way. It only affects the org's GL split.

---

## 12. Addendum — discounts ungated (owner decision)

Discounts used to be gated three ways. All three are gone:

| Was | Now |
|---|---|
| No `vouchers.discount.direct` → `403 DISCOUNT_NOT_ALLOWED` | Any salesman may discount |
| Only `vouchers.discount.approval` → `403 APPROVAL_REQUIRED:VOUCHER_DISCOUNT`, routed to a manager | No approval step |
| `vouchers.discount.max:<n>` → over-cap discounts bounced to approval | No cap |

The discount therefore always survives to the voucher, and `erp-outbox` has always
sent the resolved per-line `discountValue` (which already includes that line's
share of any header-level discount), so it always reaches the ERP.

### Why the permission keys still exist

Installed FlowVan builds decide whether to even RENDER the discount input from
`session.can("vouchers.discount.direct")`. Deleting the server check alone would
have left older APKs hiding the field. So `AuthService` projects the key set on
the way out (`effectiveSalesmanPermKeys`): `direct` is always advertised, and the
`approval` / `max:` keys are stripped. Stored `users.permissions` is untouched —
this is a read-time projection, so re-gating later is a one-line revert with no
data migration.

`VoucherViewModel` also hardcodes `canDiscount = true` so future builds don't
depend on the projection.

### Trade-off accepted

There is now **no margin control and no approval trail on discounts**. A rep can
discount 100% and it posts, mirrors to the ERP, and reduces revenue with no
second pair of eyes. Reinstating the control means restoring section 2 of
`enforceSalesmanPolicy`, dropping the projection, and re-listing the two keys in
`SalesmanDrawer` — the tests in `vouchers/discount-policy.spec.ts` and
`common/constants/permissions.spec.ts` document the current behaviour precisely
enough to invert.

### Dashboard

The two discount toggles and the max-% input were removed from the rep/user
drawers. A toggle that cannot change the outcome is worse than no toggle.
