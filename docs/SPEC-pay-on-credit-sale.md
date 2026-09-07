# Pay-on-Credit-Sale (amount paid at invoice time) — Specification

Let a salesman take an immediate **partial payment** against an accounts-receivable
(CREDIT) sale, right in the sale cart: a **"Amount paid"** field above the invoice
total (default **0**). On a non-zero amount a **collection receipt** is generated and
printed below the invoice, a **report entry** is added to the rep's reports carrying
the **source invoice number**, and the customer's balance drops by the amount.
**Activated per salesman as a permission.**

> **Status:** specification + phased plan. Implementation proceeds phase by phase.

---

## 1. Behaviour

- Shown only on a **CREDIT** sale (accounts receivable), and only when the rep holds
  the permission. Cash sales already collect in full, so the field is irrelevant there.
- **"Amount paid"** field sits **above** the total block; base value **0**; capped at
  the invoice grand total (you cannot "pay" more than the invoice at sale time — a
  larger figure is a normal advance/collection, done from the Collection screen).
- On submit with amount > 0: after the CREDIT invoice is saved, a **collection**
  (سند قبض) is created for that amount, **referencing the invoice number**, and its
  **receipt prints below the invoice**. The customer balance is reduced by the amount
  (the credit invoice raised it by the full total; the payment lowers it).
- The collection reaches the rep's reports (collections/receipts) tagged with the
  **source invoice number**.

## 2. Permission (per salesman)

A per-rep boolean `canCollectOnSale` (mirrors `canApproveStockRequest`): stored on
`users`, surfaced in the JWT permission map, granted in the salesman drawer, cached
on the device so the field shows/hides offline.

## 3. Data model

- **App:** `PaymentEntity` gains `referenceInvoiceNumber: String?` (the sale it was
  taken against) — a Room migration. Set when the collection is created at sale time.
- **BE:** the collection ingest already carries a reference concept; add/confirm the
  collection stores the source invoice number so reports can show it. (`collections`
  table + the sync collection DTO.)

## 4. Surfaces

### 4.1 Mobile (FlowVan)
- `VoucherState` gains `amountPaid: Double` (+ `canCollectOnSale`). Field rendered
  above the totals on a CREDIT sale when permitted; validated 0..grandTotal.
- `VoucherViewModel.submit()`: after `createSale(...)`, if `amountPaid > 0`, call
  `RecordCollectionUseCase(..., amount = amountPaid, referenceInvoiceNumber = invoice.number)`
  (CASH method), then navigate to / render the collection receipt below the invoice.
- Reuse `RecordCollectionUseCase` (extended with `referenceInvoiceNumber`) and the
  existing collection receipt (`ReceiptDetailScreen`).

### 4.2 Backend
- `RecordCollection` / collection ingest: accept + persist the source invoice number.
- Reports: the rep's collections report shows a **source invoice** column; the
  End-of-Day cash already counts confirmed CASH collections, so a payment-at-sale
  flows into `collectedCash` automatically.

### 4.3 Dashboard
- Salesman drawer: a **"Collect on sale"** permission toggle (`canCollectOnSale`).
- Collections report: show the **source invoice number** column.

## 5. Phases
1. **Permission** — `users.can_collect_on_sale` (BE flag + migration + extractPermissions
   + DTO) and the salesman-drawer toggle (FE). Foundation; nothing else shows until on.
2. **Mobile field + collection + receipt** — `amountPaid` field on the CREDIT sale,
   `referenceInvoiceNumber` on the payment (Room migration + use case), collection
   created at submit, receipt printed; app caches `canCollectOnSale`.
3. **Reference through to BE + reports** — persist the source invoice on the collection
   server-side; add the source-invoice column to the collections report.
4. **Ship** — APK + 94 image.

## 6. Rules to get right
- **Off by default** — no rep has `canCollectOnSale` until granted; the field never shows otherwise.
- **CREDIT only**, and **amount ≤ grand total** — anything else is a normal collection.
- **Balance math:** credit sale raises the balance by the full total; the payment
  lowers it by `amountPaid` — never double-count (the collection use case already
  does the −amount adjustment).
- **The receipt is a real collection** (سند قبض) with its own number, reaching sync,
  the ERP, and reports like any other — just tagged with the source invoice.
