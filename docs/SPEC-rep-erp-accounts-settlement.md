# SPEC — Rep ERP Accounts & End-of-Day Settlement Journal

How van cash moves to the company at end-of-day: each rep links to an ERP GL account,
three main accounts sit in Settings, and settling posts **one balanced ERP journal** that
transfers the rep's cash/cheques into the company accounts and leaves the shortfall on the
rep's account. Money is **fils** in FlowVan; the ERP journal speaks **major** decimals.

Supersedes the FlowVan cash-box model (`docs/SPEC-eod-rep-cash-accounts.md` +
`docs/SPEC-accounting-page-main-account.md`).

---

## 1. What the ERP does today (verified 2026-07-08)

- **No per-salesman GL account exists.** Only customers/suppliers/warehouses carry
  `coaAccountId`; a van is a warehouse but that account is its **inventory** account, not cash.
- **Cash sale** → `DR Customer A/R / CR Sales + Tax`. FlowVan's `sales-invoices` push sends
  **no `paymentMethod`**, so the ERP posts **no cash/bank line** — the sale sits as customer A/R.
- **Collection** → FlowVan pushes to `/receipts`, which **does not post to the GL** (only an
  allocation + a `financialTransactions` row).
- **`POST /api/v1/journal-entries`** accepts `{ externalId, description, date?, lines[] }` where
  each line is `{ accountCode, debit, credit }` (a **CoA code**, not id), enforces
  `debits == credits`, scope `accounting:write`, idempotent per `externalId`.

**Consequence:** van cash is **not** in any GL cash account yet, so the settlement journal is
**self-contained** — it records the transfer without double-counting a prior cash posting.
(The sale-side A/R vs. this reconciliation account is squared off ERP-side; see §6.)

---

## 2. Accounts

| Account | Where set | Role |
|---|---|---|
| **Rep account** (custody) | Rep drawer → `reps.erp_account_code` | Per-rep receivable — carries the **shortfall** (what the rep still owes). |
| **Sales account (reconciliation)** | Settings → Accounting | **Credit/clearing** side of the settlement. A balance-sheet clearing account — **NOT** the P&L sales-revenue account (that already booked the sale). |
| **Cash Collections account** | Settings → Accounting | Debit destination for the **received cash**. |
| **Cheque Collections account** | Settings → Accounting | Debit destination for the **cheque total** (cheques always in full). |

All four are ordinary ERP chart-of-accounts entries the admin creates in the ERP and picks by
code in FlowVan (via the `/erp/chart-of-accounts` passthrough). Nothing is created in FlowVan.

---

## 3. The settlement journal

On `POST /reports/end-of-day/settle`, after the `SalesmanSettlement` row is written, build one
balanced journal (skip + warn if the rep or a needed account is unlinked):

```
externalId : settlement-<id>          (idempotent)
description: تسوية مندوب المبيعات (<rep>) — <periodTo>
             / Sales Representative Settlement (<rep>) — <periodTo>
date       : periodTo
```

Amounts (fils; rendered ÷1000 to major for the ERP):

```
salesCash      = cash_sales − cash_returns
collectionCash = collected_cash
chequeBal      = collected_cheque
expected       = salesCash + collectionCash
received       = received_fils              (cash the admin actually took)
shortfall      = max(0, expected − received)
overpay        = max(0, received − expected)
accountable    = expected + chequeBal
```

Lines:

| Line | Account | Debit | Credit |
|---|---|---:|---:|
| Received cash | Cash Collections | `received` | |
| Cheques | Cheque Collections | `chequeBal` | |
| Shortfall | Rep account | `shortfall` | |
| Overpayment | Rep account | | `overpay` |
| Reconciliation | Sales account | | `accountable` |

**Balance** — DR `received + chequeBal + shortfall` vs CR `overpay + accountable`:
- received ≤ expected → `received + chequeBal + (expected−received)` = `expected + chequeBal` = CR ✔
- received > expected → `received + chequeBal` = `(received−expected) + expected + chequeBal` = CR ✔

Zero-amount lines are dropped. A required account unset ⇒ **skip the journal** (the settlement
still records; a warning is logged and the EOD dialog flags it).

### Worked example (owner's)
150 cash sales + 30 cash collected + 400 cheques, rep hands **160**:
`DR Cash 160 · DR Cheque 400 · DR Rep 20 · CR Sales(recon) 580` — balanced. Rep account
carries **20** (owes); cash + cheques land in the company accounts. If the rep hands **200**
(≥ 180 expected), the Rep line flips to `CR Rep 20` — paying down prior custody debt.

---

## 4. FlowVan changes

**Backend** (data + endpoints already in place from the prior iteration):
- `reps.erp_account_id/code` (migration `1721401000000`), editable in the rep drawer even in
  ERP mode. ✔
- `app_settings` three account refs + `PATCH /settings/accounting` (NOT ERP-read-only). ✔
- **`CashAccountsService.buildSettlementJournal` — rewrite to §3** (this task): was recognising
  the full expected into the mains + a cash-side shortfall contra (double-counts); replace with
  the reconciliation shape above.
- `settle` enqueues `REP_SETTLEMENT_JOURNAL` when buildable, else records with a warning. ✔

**Frontend:**
- Rep drawer account picker. ✔
- Settings → Accounting: three CoA pickers. ✔ — **relabel** the "Sales" picker as the
  *reconciliation* account and fix the hints to match §3.
- EOD settle dialog: show the journal preview (received → Cash, cheques → Cheque, shortfall →
  Rep, balancing CR → Sales) and warn when an account is missing.

---

## 5. Acceptance
- Settling a rep with all four accounts linked posts a **balanced** journal matching §3; the rep
  account shows the shortfall (or a credit on overpayment).
- Missing rep/main account ⇒ settlement records, **no** journal, EOD dialog warns.
- Retrying the outbox never double-posts (idempotent on `settlement-<id>`).
- Verify gate green both stacks; migration applied.

## 6. Notes & open items
- **Reconciliation account** accrues the credit side each settlement; square it off ERP-side
  against the sale/A/R postings. Keep it a dedicated **clearing** account (not revenue) to avoid
  double-counting revenue.
- If the owner wants **cash-sale cash and collection cash in separate destinations** (a Sales
  cash box vs a Cash Collections box), split the "Received cash" line by a priority rule
  (collections first, remainder to sales; shortfall falls on sales) — a small follow-up. This
  spec routes all received cash to Cash Collections for a single clean line.
- A future "proper" model posts each collection as `DR rep custody / CR customer A/R` per
  transaction, making settlement a pure transfer — needs reworking the collections→ERP
  integration; out of scope here.
