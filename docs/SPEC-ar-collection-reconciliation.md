# SPEC — Fix: Collections must reduce the customer receivable (AR)

Credit sales raise a customer's receivable, but **collections (cash receipt / cheque) never
bring it back down** — the balance stays inflated across the ERP, the dashboard, and the
mobile app. This is one root cause in the ERP with cascading symptoms downstream.

Investigated 2026-07-10 across all three systems. Related: [accounts-receivable plan](SPEC-accounts-receivable.md).

---

## 1. Root cause (ERP) — two disjoint data stores

Every customer-balance metric in the ERP is derived from **invoices**:
`outstanding = Σ(invoices.total_amount) − Σ(invoices.amount_paid)` — used by the van balance
API (`customers/[id]/balance/route.ts:46`), credit-limit enforcement
(`lib/ar/credit-check.ts:32`), and the statement UI (`customers/[id]/statement/page.tsx:130`).

FlowVan pushes collections to **`POST /api/v1/receipts` with NO `invoiceNumber`**
(`erp-outbox.service.ts:229` — body is `{externalId, customerCode, amount, paymentMethod, notes}`).
The ERP's **on-account branch** (`receipts/route.ts:149-161`) writes **only** a
`financial_transactions` `cash_receipt` shim — it does **not**:
- update `invoices.amount_paid`, - create an `invoice_payments` allocation, - post any GL
journal (no `RECEIPT_VOUCHER`, no CR to Customer A/R).

That shim row is read by **no** balance query. So the sale raises the balance and the
collection reduces **nothing** — the receivable and the consumed credit limit stay overstated
by the collected amount, and the GL Customer A/R is never credited.

`POST /api/v1/payments` *does* it correctly (updates `amount_paid` + posts DR Bank / CR
Customer A/R via `RECEIPT_VOUCHER`) but hard-requires an invoice, and FlowVan doesn't use it.

## 2. Cascading symptoms

- **Dashboard (`cash-van-dashboard-frontend/features/ar`)** proxies the ERP for balance +
  aging (`ar/api.ts:7` "ERP is the source of truth") → shows the inflated balance.
- **FlowVan backend (`cash-van-dashboard`)** stores `customers.total_debt`, which is **only ever
  overwritten wholesale** by `erp-sync pullCustomerBalances()` from ERP aging
  (`erp-sync.service.ts:948`); the collection confirm path never decrements it. So `total_debt`
  (used by `/ar/customers/:num/balance` fallback, `/ar/arrears-summary`, debtors report,
  ai-insights) inherits the inflated ERP number — and stays wrong entirely when ERP/`directExport`
  is off. (The *derived* `ArService.receivables()` at `ar.service.ts:297` already subtracts
  collections correctly — it is the reference for what the stored path is missing.)
- **Mobile app (KMP/Compose, Room)** — `RecordCollectionUseCase.kt:66` DOES `adjustBalance(-amount)`
  locally, but `CustomerDashboardViewModel.refresh()` (fired on `ON_RESUME`,
  `CustomerDashboardScreen.kt:84`) re-fetches `customerApi.getById` and `cacheAll`-REPLACEs the
  row (`CustomerDao` `OnConflictStrategy.REPLACE`), **clobbering the decrement** with the server's
  un-reduced balance. Credit sale (`CreateSaleVoucherUseCase.kt:157`) increments and *sticks*
  (server mirrors it) → the reported asymmetry. Credit-limit checks (`:89`) then run against the
  stale, inflated balance and can **wrongly block legitimate sales**.

**One-line root cause:** an on-account van collection is recorded as a shim row the ERP's
receivable formula never reads → the receivable is never paid down anywhere.

---

## 3. Fix plan — three layers (fix the root first; the rest is correctness/UX)

### Layer 1 — ERP: make an on-account receipt actually reduce A/R  *(the root fix)*

**Code — `ERP/src/app/api/v1/receipts/route.ts` on-account branch (`:149-161`):**
1. **FIFO-allocate** the receipt across the customer's **open invoices** (oldest first): for each,
   write an `invoice_payments` row and bump `invoices.amount_paid` + recompute `status`, until the
   amount is consumed.
2. **Post the GL journal** — emit `RECEIPT_VOUCHER` via the posting engine (DR Bank/Cash / CR
   Customer A/R), **savepoint-isolated + try/catch** (same pattern just added to `/sales-invoices`
   step 6) so a posting-config gap never 500s the collection.
3. **Over-collection** (amount > total open) → apply what fits; leave the remainder as an
   on-account **advance/credit** (keep the `financial_transactions` shim for the unapplied part, or
   a negative-balance customer credit) — decision §5.
4. Keep idempotency on `externalId` (already present via `external_document_refs`).

**Config (per org, prerequisite for the journal):**
- Create/tag a **Bank/Cash** account with `system_account_key = 'BANK'` (org `a594bd71…` currently
  has none — same gap we hit for sales; A/R `1101` already exists from the sales-template setup).
- Add a **`RECEIPT_VOUCHER` posting template** (DR `SYSTEM_CODE BANK` PAYMENT_AMOUNT / CR
  `CUSTOMER_COA` PAYMENT_AMOUNT — the app's default at `seed-templates.ts:81`).
- Set `posting_settings` `RECEIPT_VOUCHER = AUTO_ON_SAVE` for the org.

*Alternative considered:* have FlowVan call `/payments` with an invoice ref instead. Rejected —
van collections are on-account against the customer's overall debt (may span invoices; rep doesn't
know ERP invoice numbers). On-account FIFO allocation in `/receipts` is the correct model.

### Layer 2 — FlowVan backend: keep the local receivable correct without waiting on ERP round-trip

Today `customers.total_debt` is only right *after* the collection reaches the ERP **and** a
customer sync pulls the lowered balance back — and never in ERP-off mode. Choose one:

- **2a (recommended, minimal):** in the `erp.collection.confirmed` handler, locally
  **decrement `customers.total_debt` by the collected amount** (cash+cheque), mirroring how a
  credit sale should raise it — add a matching **+increment on credit-sale voucher post**
  (`vouchers.service` post path). Then `pullCustomerBalances()` still reconciles against the ERP
  as the authority. Immediate, works offline, self-heals on sync.
- **2b (cleaner, larger):** converge the stored-balance consumers (`customerBalance` fallback,
  `arrears-summary` `totalReceivable`, debtors report, ai-insights) onto the **derived**
  `ArService.receivables()` computation, and treat `total_debt` as a cache only. Removes the
  dual-source-of-truth entirely.

Recommend **2a for delivery**, **2b as a follow-up cleanup**.

### Layer 3 — Mobile app: don't clobber the local decrement; credit-check the corrected balance

At the refresh/merge boundary (`CustomerDashboardViewModel.refresh()` `:80`,
`RefreshCatalogUseCase.kt:63`):
- **Do not overwrite `CustomerEntity.balance` from the server while unsynced local payments exist**
  for that customer — OR recompute the displayed balance as `serverBalance − Σ(unsynced local
  payments)`, OR (cleanest) **derive the balance locally from invoices − payments** (as
  `AccountStatementScreen` already does) instead of trusting the server field.
- Ensure the **credit-limit check** (`CreateSaleVoucherUseCase.kt:89`) uses that corrected balance.

Once Layers 1–2 land, the server balance *will* drop after sync, so the clobber becomes
correct-eventually — but Layer 3 still matters for the transient revert and offline credit checks.

---

## 4. Sequencing & acceptance

1. **Layer 1** (ERP) — the root. *Accept:* a van credit sale raises the customer's ERP balance;
   a van collection **reduces** it (invoice `amount_paid` up, GL Customer A/R credited, balanced
   journal); over-collection leaves an advance; retry is idempotent.
2. **Layer 2** (FlowVan BE) — *Accept:* `/ar/customers/:num/balance` and `/ar/arrears-summary`
   drop by the collected amount immediately after confirm, even with ERP off; reconcile with ERP on
   next sync (no drift).
3. **Layer 3** (mobile) — *Accept:* after a collection the dashboard balance stays reduced across
   `ON_RESUME`; a legitimate sale within limit is not blocked post-collection.
4. **End-to-end:** credit sale → balance up on app+dashboard+ERP; collection → balance down on all
   three and stays down.

## 5. Open decisions (need product/accounting confirmation)

1. **Cheque timing:** does a **cheque** collection reduce the receivable **immediately** (on
   collection), or only when **deposited/cleared**? Accounting-standard is often "cheques under
   collection" (DR Cheques-under-collection / CR A/R now, DR Bank / CR Cheques-under-collection on
   clearing) so A/R drops at collection but cash isn't recognised until clearing. Simpler: treat a
   cheque like cash and reduce A/R immediately. **Confirm** — affects the RECEIPT_VOUCHER debit
   account for cheques.
2. **Over-collection / advances:** hold the surplus as an on-account customer credit (negative
   balance) that auto-applies to the next invoice? Or block over-collection?
3. **Layer 2 choice:** 2a (decrement `total_debt`) vs 2b (derive everywhere).
4. **Historical backfill:** existing on-account receipts already pushed as shims never reduced A/R.
   Do we run a one-off reconciliation to allocate historical receipts against open invoices, or
   start clean from a cutover date?
