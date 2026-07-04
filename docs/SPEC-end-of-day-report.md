# Spec — End-of-Day salesman cash reconciliation report

Status: **APPROVED — implementing** · Scope: cash-van backend (NestJS) + dashboard FE (Next.js).

## Goal
A dashboard page that summarizes each salesman's **sales, returns, and collections** over a chosen date range (an "End of Day" report), lets the admin record **how much cash the salesman handed over**, and **carries the difference forward** as a running per-salesman balance (shown on later days as an "additional" amount due).

## Decisions (confirmed)
1. **Cash only** is reconciled against the handover. Cheques are shown **separately** and are NOT part of the cash shortfall/carryover.
2. A return reduces expected cash **only when refunded in cash** (a RETURN voucher with a `CASH` payment). On-account/credit returns don't affect cash.
3. **Overpayment credits the balance** (new balance can go negative = salesman in credit). The admin controls this via the "received" amount and a note.
4. **Running balance**; the admin picks the date range. New balance = previous balance + expected cash − received. Carried to future reports.

## Money & data facts
- Collections: `amount` in **fils**; `method` cash|cheque; `status` pending|confirmed|deposited|bounced; `repId`; `collectedAt`.
- Voucher header: `numeric(14,3)` **JOD major**; `transKind` SALE|RETURN|…; `userCode` (salesman); `inDate`; `isPosted`.
- Payments: `paymentType` CASH|CREDIT|CHEQUE|TRANSFER|CARD; `amount` **JOD major**; linked by `voucherNumber`.
- Salesman: `voucher.userCode → user.userNumber → user.id → rep.userId → rep{id,code,nameAr}`. Collections use `repId` directly.
- **Internal unit = fils.** Convert voucher/payment JOD-major → fils (`×1000`) in aggregation; return fils; FE formats with `formatJOD`.

## Aggregation (per salesman, over [from, to], posted only)
- `collectedCashFils` = Σ collections.amount where `method='cash'` AND `status IN ('confirmed','deposited')`.
- `collectedChequeFils` = Σ collections.amount where `method='cheque'` AND `status IN ('confirmed','deposited')`.
- `cashSalesFils` = Σ payments.amount (×1000) where `paymentType='CASH'` AND header `transKind='SALE'` AND `isPosted`.
- `creditSalesFils` = Σ payments.amount (×1000) where `paymentType='CREDIT'` AND `transKind='SALE'` AND `isPosted`.
- `cashReturnsFils` = Σ payments.amount (×1000) where `paymentType='CASH'` AND `transKind='RETURN'` AND `isPosted`.
- `totalDiscountFils` = Σ header.totalDiscountValue (×1000) for SALE vouchers (info only).
- **`expectedCashFils` = cashSalesFils + collectedCashFils − cashReturnsFils.**  ("total current cash with salesman")
- Attribution by salesman: collections by `repId`; vouchers by `userCode` → rep (LEFT JOIN through user). Unmapped userCodes grouped under "—".
- A row also carries `previousBalanceFils` (the rep's current outstanding from prior settlements) and `lastSettledTo` (date).

## New entity — `salesman_settlement`
| column | type | note |
|---|---|---|
| id | uuid pk | |
| rep_id | uuid | FK reps.id |
| period_from / period_to | date | the reconciled range |
| expected_cash_fils | bigint | snapshot at settle time |
| collected_cash_fils, collected_cheque_fils, cash_sales_fils, credit_sales_fils, cash_returns_fils, total_discount_fils | bigint | snapshots (audit) |
| previous_balance_fils | bigint | rep balance before this settlement |
| received_fils | bigint | cash handed over by the salesman |
| new_balance_fils | bigint | previous + expected − received |
| note | text null | |
| created_by_user_id | uuid null | the admin |
| created_at | timestamptz | |

- **Current outstanding balance** for a rep = `new_balance_fils` of the latest settlement (by created_at), else 0.
- Migration adds the table (TypeORM migration; run `npm run migration:run`).

## Backend API (reports module, admin/manager)
1. **`GET /reports/end-of-day?from&to&repId?`** → `{ rows: EodRow[], totals: EodTotals }`.
   - `EodRow` = `{ repId, repCode, repName, collectedCashFils, collectedChequeFils, cashSalesFils, creditSalesFils, cashReturnsFils, totalDiscountFils, expectedCashFils, previousBalanceFils, lastSettledTo, totalDueFils }` where `totalDueFils = expectedCashFils + previousBalanceFils`.
   - One row per salesman that has activity in range OR a non-zero balance.
2. **`POST /reports/end-of-day/settle`** `{ repId, from, to, receivedFils, note? }` → recomputes the period's aggregates server-side (don't trust client numbers), reads `previousBalance`, writes a `salesman_settlement`, returns the row incl. `newBalanceFils`.
   - Guard: warn (not block) if `from` < rep's `lastSettledTo` (possible double count). Block negative `receivedFils`.
3. **`GET /reports/end-of-day/settlements?repId?&from?&to?`** → settlement history (audit + "additional on this salesman").

## Frontend
- New page **/reports/end-of-day** (nav entry, admin/manager) — or a tab in ReportsView. Use `from`/`to` date pickers (default: today) + optional salesman filter.
- **Table** (one row per salesman): Salesman · Cash collected · Cheque collected · Cash sales · Credit sales · Cash returns · **Expected cash** · Previous balance · **Total due** · [Settle]. A totals footer row.
- **Settle modal**: shows Expected + Previous balance = **Total due**; admin enters **Received from salesman**; live-computes **New balance** (carryover, +owed / −credit) with a note; confirm → POST settle → toast + refresh.
- **Carryover display**: the "Previous balance" column (and the post-settle "New balance") is the "additional on this salesman shown on other days".
- A **history** drawer/section listing past settlements per salesman.
- Money rendered with `formatJOD` (fils). Bilingual strings in the dictionary; RTL.

## Edge cases
- Salesman with no activity but a carried balance → still listed (so the debt is visible/collectable).
- Overlapping ranges → not blocked; surface `lastSettledTo` + warn in the settle modal.
- Cheques: shown for visibility; excluded from expected cash and carryover.
- Unmapped `userCode` (no rep) → grouped row "—", not settleable.
- Overpayment → `newBalance` negative = credit; shown distinctly (e.g. green "credit").

## Acceptance
- Selecting a date range shows per-salesman cash/cheque/sales/credit/returns/discount + expected cash.
- Settling with received < expected adds the shortfall to the salesman's balance; next day's report shows it as Previous balance / Total due.
- Settling with received > total due shows a credit (negative balance) carried forward.
- The sale/collection records are never mutated by settlement.
