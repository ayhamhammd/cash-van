# SPEC — Cash or credit on a salesman's return

Status: **building** (2026-11-26). One spec for the four systems:
- the app (FlowVan);
- this backend;
- the dashboard (cash-van-dashboard-frontend);
- the ERP.

## 1. The rule

On every return, the salesman says how the customer is paid back:

| Choice | What happens |
|---|---|
| **Credit** (آجل) | As today. The return is credit on the customer's account. Nobody's cash moves. |
| **Cash** (نقدي) | The salesman pays the customer from the van's cash. His expected cash for the day goes **down** by the amount. The customer's balance does not change: the goods came back and the money went out. |

- **Who may choose Cash:** only a salesman with the new permission **`canCashReturn`**.
  - It is a per-salesman switch, off by default, managed like `canUseCardPayment`.
  - Everyone else gets Credit only, exactly as today.
- **Making the choice:** a salesman with the permission must make it every time. Nothing is pre-selected.
- **Cash limits.** A cash return may not be more than either of:
  1. the cash he is carrying right now:
     - today's cash sales;
     - plus today's cash collections;
     - minus today's earlier cash returns.
  2. what is left of the original sale it returns against:
     - the sale's total;
     - minus the returns already made against it, cash or credit.
- **Over a limit:** the app refuses Cash, shows the limit, and offers Credit. It never splits a return.

This replaces the "returns are credit only" rule from 2026-09-25 (backend e0b8836, app 5ad4f30, ERP c7ff234), for salesmen who have the permission.

## 2. What already holds (no change)

- **App, customer account overlay:** `CustomerStatement.isLedgerEntry` already leaves a non-credit return out of the customer's balance.
- **Backend, customer debt:** `applyCreditVoucherToDebt`, the A/R notes and the unposted-debt overlay count only CREDIT rows. A CASH return already leaves `total_debt` alone.
- **Backend, rep sales box:** the box ledger (`cash-accounts.service`, on `erp.voucher.posted`) already posts a RETURN's CASH rows negative.
- **ERP refunds:** since b944ec3b the ERP refunds a credit note in cash, through `recordCashRefund`:
  - a negative `invoice_payments` row;
  - a SALES_REFUND journal: DR customer, CR the van's cash box (resolved by the van's warehouse);
  - the refund is taken off the van's expected cash on the day of the return.
  - The customer's statement nets to zero.

## 3. The gap today, and a mismatch it fixes

- **The ERP guesses.** It refunds a return only when the **original sale** was paid on the spot, and in that sale's method. The salesman cannot choose:
  - a credit sale's return never refunds;
  - a card sale's return refunds to card.
- **The two sides already disagree.** VanFlow forces every return to credit. Meanwhile an ERP from after 19 Oct refunds a returned *cash* sale from the van box. So VanFlow's end of day and the ERP's van end of day can differ by those refunds.
- **The fix:** the backend now tells the ERP what the salesman chose (§5.4), and the ERP follows it.

## 4. App (FlowVan)

1. **Permission**
   - New field `permissions.canCashReturn` on login and `auth/me`.
   - Store it as `SessionStore.canCashReturn` with key `can_cash_return`.
   - Remove it in `clear()`.
   - Add it to `PROFILE_BOOLEAN_KEYS`, so it survives an offline sign-in.
   - Write it in `BackendLoginUseCase` and `RefreshCatalogUseCase`, like `canUseCardPayment`.
2. **Offer.** `VoucherState.offeredPaymentMethods` for a RETURN:
   - `[CREDIT, CASH]` when `canCashReturn`;
   - else `[CREDIT]`.
3. **Must choose**
   - With the permission, a RETURN starts with no method chosen (`returnMethodChosen = false`).
   - Picking the source sale no longer sets CREDIT.
   - `canSave` requires a choice.
   - The save sheet's payment dialog shows both options, titled «طريقة إرجاع المبلغ».
   - Without the permission, nothing changes: CREDIT, no question asked.
4. **Limits**
   - **Cash in hand:**
     - computed from the device: today's CASH sales (`cashOnlySalesTotalSince`), plus today's cash collections, minus today's CASH returns;
     - restore `cashReturnsTotalSince`, CASH only;
     - "today" is the same window End of Day uses.
   - **Sale remaining:**
     - the source sale's total, minus the totals of non-cancelled RETURN rows whose `referenceInvoiceId` is that sale;
     - for a sale found on the server (`lookupSourceByNumber`), keep its `netTotal` in state; the server's own check (§5.2) is the authority there.
   - **Applied when Cash is chosen and when saving:** the cart total must be ≤ min(both limits).
     - Otherwise show the message «لا يمكن إرجاع نقدي أكثر من X — النقد معك Y، المتبقي من الفاتورة Z», and keep Credit available.
5. **End of Day**
   - `cashOnHand = cashSales + cashCollected − cashReturns`.
   - Show "cash returns" as a line on the screen and on the printed copy.
6. **Upload.** No change: the return already sends one payment row of its method (`toVoucherRequest`).
7. **Print**
   - The thermal receipt already prints نقدي / آجل.
   - The A4 copy of a cash return reads «مدفوع نقداً للعميل» instead of "Paid".
8. **Tests:** offered methods per permission, must-choose, both limits, the End-of-Day formula, the offline profile round-trip.

## 5. Backend (this repo)

### 5.1 Permission
- **Database:** column `users.can_cash_return boolean NOT NULL DEFAULT false` (migration `CashReturn`).
- **DTOs:** the create DTO; update and response DTOs pick it up.
- **Auth:** `extractPermissions` adds `canCashReturn`.
- **Auto-provisioned reps:** default false.

### 5.2 Intake (`returnsAreCredit` becomes `returnPayment`)
- **Keeping Cash:** a RETURN keeps a single **CASH** row only when:
  - every row it sent is CASH; and
  - the creating salesman has `canCashReturn` (or it is an office user).
- **Everything else:** collapses to one CREDIT row, as today. That covers CARD, CHEQUE, mixed rows, and a salesman without the switch.
  - Old APKs always send CREDIT, so they are unchanged.
- **Cap against the original sale.** For a CASH return:
  - the limit is the sale's `net_total`, minus the `net_total` of earlier non-cancelled RETURNs with the same `reference_voucher_number`;
  - online over the limit: 400 `CASH_RETURN_OVER_SALE`;
  - offline sync: the money has already been handed over, so it posts, and managers are notified. Same for a salesman without the switch. This mirrors `flagUnpermittedCard`.
- **Cash in hand:** the server does not check it. Cash collected offline is not on the server yet, so its figure would be wrong. The phone enforces it.

### 5.3 End of Day and settlement
- `eodRows` splits returns into two figures:
  - `cashRefundsFils`: CASH rows of RETURN;
  - `returnsCreditFils`: the rest, shown only.
- **Expected cash:** `expectedCashFils = cashSales + collectedCash − cashRefunds`. It may go negative, meaning the salesman paid out more than he took.
- **Settlement:** stores `cash_refunds_fils` (new column) beside `cash_returns_fils`. The settlement journal already reads the stored expected cash.
- **Specs:** the "returns are credit" integration spec becomes "credit returns are not cash; cash returns are".

### 5.4 ERP push
- `buildReturn` adds `refundMethod: 'CASH' | 'CREDIT'`, from the voucher's payment row.
- An older ERP strips the unknown key and keeps guessing.

## 6. Dashboard (frontend)

- **Salesman drawer:**
  - a new `PERMISSION_FIELDS` entry `canCashReturn`, labelled «السماح بالإرجاع النقدي» / "Allow cash returns";
  - hint: «يدفع المندوب للعميل من نقد السيارة، ويُخصم من النقد المتوقع» / "The salesman pays the customer from the van's cash; it comes off his expected cash";
  - added to the `EMPTY_PERMS` default and to the types;
  - hidden for delivery reps.
- **End of Day view:**
  - expected cash = cash sales + collections − cash returns, in the client copies of the formula;
  - rename "Returns (customer credit)" into two lines: "Cash returns" (subtracted) and "Credit returns" (shown);
  - fix the subtitle "cash sales + collections".

## 7. ERP

1. **Field:** `CreateReturnSchema` gains an optional `refundMethod: 'CASH' | 'CREDIT'`.
   - **Absent:** today's behaviour, for older VanFlow builds and the ERP's own screens.
   - **CREDIT:** no refund, even when the original sale was cash.
   - **CASH:** refund the credit note's full total in **cash** from the return's warehouse (the van), whatever the original sale's method.
     - New `recordCashRefund` option `force: { method: 'cash' }`. It skips the paid-on-the-spot check, and the amount is the credit total.
     - Still at most one refund per credit note.
2. **Response:** returns `refund: { amount, method } | null`.
3. **Van settlement**
   - `hasSettleableActivity` counts cash refunds. Otherwise a van whose only activity is a refund is refused with NO_ACTIVITY.
   - `van_settlements.cash_refunds` is stored (migration 0203).
   - The settle dialog shows the refunds line.
4. **Stale comments and i18n:** "Returns (customer credit)" and "no money is handed back".
5. **Tests:** CASH on a credit sale refunds in cash from the van box; CREDIT on a cash sale does not refund; absent keeps today's behaviour; once only; the van can settle on refunds alone.

## 8. Deploy order and compatibility

- **Any order is safe:**
  - Backend before ERP: the ERP strips `refundMethod` and keeps guessing.
  - ERP before backend: `refundMethod` is never sent, so the ERP guesses as today.
  - App before backend: the backend has no `canCashReturn`, so no salesman is offered Cash.
- **What a client needs for the full feature:** a backend with this change, an ERP with migration 0203, and app ≥ the build that ships §4.
- **Reaching the field:** the switch defaults off, so nothing changes until the office turns it on for a salesman.
