# SPEC — Accounting Page, Main Account, & Zero-After-Settle EOD

Refinement on top of the shipped [rep cash accounts feature](SPEC-eod-rep-cash-accounts.md).
Extends: `cash-accounts` module, `SalesmanSettlement`, `POST /reports/end-of-day/settle`,
the EOD view, and Settings. Money is **fils** everywhere in the dashboard.

## Decisions (locked with owner, 2026-07-08)

1. **Cash Accounts becomes a top-level "Accounting" menu item.** Move the account
   registry + rep-box ledgers out of Settings into a dedicated `/accounting` page.
   Remove the `Settings → Cash Accounts` tab. Keep only the settle flow inside EOD.
2. **One fixed "Main Account".** The admin designates a single COMPANY account as the
   main account. Settling any rep automatically sweeps all three boxes into it — the
   settle dialog no longer asks the admin to pick destinations.
3. **Zero-after-settle EOD.** Once a rep's period is settled, that day's End-of-Day
   recon reads **zero** for the rep. The settled amount is visible **only** in the
   account ledger (the SETTLEMENT_OUT/IN rows), not in the EOD recon report.
4. **Keep the 3-box model.** Sales / receipts / cheques boxes stay as-is; no per-rep
   combined-vs-split configuration.

---

## Part A — Backend (dash-api)

### A1. Designate the Main Account (`app_settings`)

- **Migration**: add nullable `main_cash_account_id uuid` to `app_settings`
  (FK → `cash_accounts.id`, `ON DELETE SET NULL`).
- **Entity**: `AppSettings.mainCashAccountId: string | null`.
- **DTO / service**: `UpdateAppSettingsDto.mainCashAccountId?: string | null`; surface it
  in `AppSettingsView` (e.g. under a new `accounting: { mainCashAccountId }` block).
- **Validation** on set: account must exist, `kind = 'COMPANY'`, `is_active = true`.
  Reject otherwise with a clear 400.
- Files: `src/modules/settings/entities/app-settings.entity.ts`,
  `dto/update-settings.dto.ts`, `settings.service.ts`, new migration under
  `src/database/migrations/`.

### A2. Auto-default settle transfers to the Main Account

In `ReportsService.settle` (`src/modules/reports/reports.service.ts:336`):

- Before calling `settleTransfers`, resolve `mainId = settings.mainCashAccountId`.
- If `dto.transfers` is empty/omitted, build
  `transfers = { salesAccountId: mainId, receiptsAccountId: mainId, chequesAccountId: mainId }`.
  (Admin-supplied transfers, if any, still win — future-proofing; the UI stops sending them.)
- If `mainId` is unset: keep today's best-effort behavior (boxes stay non-zero, logged
  warning) **and** the EOD page shows a "set a Main Account" banner (see B4). Do **not**
  hard-block the settlement record.
- `CashAccountsService.settleTransfers` already accepts the same destination id for all
  three boxes (`cash-accounts.service.ts:280`). It will post three `SETTLEMENT_IN` rows
  into the main account — acceptable. *Optional tidy-up:* coalesce same-destination boxes
  into one `SETTLEMENT_IN` sum so the ledger shows one credit per settlement.
- **ERP GL**: unchanged — `buildSettlementJournal` reconstructs DR main / CR box from the
  ledger. The main account needs `erp_account_code` set for the journal to post; if
  unlinked, the legacy `CASH_SETTLEMENT` push is used (existing fallback).

### A3. Zero-after-settle EOD math (the core change)

Today EOD recomputes `expectedCashFils` from source vouchers/collections in the window,
so it never drops to zero after a settle. Retarget it to the **ledger**, which already
nets to zero once the boxes are emptied.

**Recommended:** compute the rep's expected cash for `[from,to]` as the net of their
box entries in that window:

```sql
SELECT COALESCE(SUM(t.amount_fils),0)::bigint AS expected
  FROM account_transactions t
  JOIN cash_accounts a ON a.id = t.account_id
 WHERE t.rep_id = $rep
   AND a.kind IN ('REP_SALES','REP_RECEIPTS','REP_CHEQUES')
   AND t.entry_kind IN ('SALE','COLLECTION','CHEQUE','SETTLEMENT_OUT')
   AND t.created_at::date BETWEEN $from AND $to
```

- `SALE/COLLECTION/CHEQUE` are `+`, `SETTLEMENT_OUT` is `−`. After settle they cancel →
  the day reads **zero**. Before settle → the day's real cash. Destination
  (`SETTLEMENT_IN` on COMPANY) rows are excluded by the `a.kind` filter.
- `previousBalanceFils` (carried shortfall) logic is **unchanged** — it still comes from
  the prior settlement record.
- **Reconciliation guard**: because boxes started empty at the feature's deploy (no
  historical backfill — see the parent spec §7), pre-feature days will read differently
  from the old voucher-based number. Add a one-off validation/log comparing the two for a
  sample period; document the cutover date in the release note.

**Simpler fallback** (if the ledger retarget is deemed risky): keep the voucher-based
`expectedCashFils`, but if a settlement exists for the rep whose `period_to >= to`, force
the displayed `expectedCashFils`/`totalDueFils` to `0` and flag `settled: true`. Coarser
(any later settlement zeros earlier days) but a 5-line change. **Recommend A3-primary.**

Files: `src/modules/reports/reports.service.ts` (the EOD aggregate query ~`:262`).

---

## Part B — Frontend (dashboard)

### B1. New "Accounting" nav group + page

- `src/components/layout/nav.ts`: add a group (or item under an existing group) —
  `{ href: "/accounting", labelKey: "view.accounting", icon: "Landmark", minRole: "manager" }`.
  Suggested new group `nav.accounting`, or place under `nav.insights` next to EOD.
- `src/components/layout/icons.ts`: ensure the chosen lucide icon is registered.
- `src/app/(dashboard)/accounting/page.tsx`: thin server component → `<AccountingView />`.
- `src/features/accounting/AccountingView.tsx`: `"use client"`, tabbed:
  - **Tab 1 — Accounts registry**: move `CashAccountsTab` here
    (`src/features/cash-accounts/CashAccountsTab.tsx`), add the Main-Account control (B3).
  - **Tab 2 — Rep box ledgers**: move the per-rep sales/receipts/cheques ledger UI that
    currently lives in `EndOfDayView`'s `accounts` tab.
- i18n: add `view.accounting`, `nav.accounting`, and main-account strings to
  `src/lib/i18n/dictionaries.ts` (ar + en).

### B2. Remove the Settings tab

- `src/features/settings/SettingsView.tsx:156`: delete the `cashAccounts` tab render and
  its tab-button entry. (Component stays, now imported by `AccountingView`.)

### B3. Main-Account designation UI (Accounting → registry tab)

- In the accounts table, show a **star / "Main" badge** on the designated COMPANY account.
- A "Set as main account" action on each COMPANY row → `PATCH /settings { mainCashAccountId }`.
- Read current main from the settings query; invalidate settings + cash-accounts on success.
- RBAC: admin only (mutation), manager+ can view.

### B4. Simplify the EOD settle dialog

- `src/features/reports/EndOfDayView.tsx` `SettleModal` (~`:293`): **remove** the three
  destination account pickers. Instead show a read-only line: "Boxes will be swept to
  **{Main Account name}**" with the three box balances.
- If no main account is configured, show an inline warning + link to `/accounting` and
  disable/soft-warn on confirm (settlement still records; boxes just won't sweep).
- Drop the `accounts` tab from `EndOfDayView` (moved to the Accounting page in B1); the
  EOD page keeps only the `recon` tab.
- Settle mutation stops sending the `transfers` block (backend defaults to main — A2).

### B5. Verify zero-after-settle in the UI

- After a settle, re-querying that day's EOD recon shows the rep row at `0` due (from A3).
- The settled amount remains visible in **Accounting → rep ledgers** as SETTLEMENT_OUT
  (rep box) and SETTLEMENT_IN (main account).

---

## Part C — ERP

No new ERP work. The GL journal (DR main / CR box) already reconstructs from the ledger.
**Action item:** ensure the designated Main Account has `erp_account_code` set so
settlements post as journals rather than falling back to the legacy push.

---

## Phased plan & acceptance

**Phase 1 — Backend**
- [ ] A1 migration + entity + DTO + settings view + validation
- [ ] A2 settle defaults transfers → main account (+ no-main warning path)
- [ ] A3 EOD expected-cash retargeted to ledger net (reads zero after settle) + reconciliation log
- ✅ *Accept:* settling a rep with a configured main account sweeps all boxes into it and
  the same day's EOD recon then reads zero for that rep; the ledger shows the OUT/IN pair.

**Phase 2 — Frontend**
- [ ] B1 new Accounting page + nav + i18n (registry + rep ledgers moved in)
- [ ] B2 remove Settings tab
- [ ] B3 main-account designation UI
- [ ] B4 simplified settle dialog (no pickers) + EOD keeps only recon tab
- ✅ *Accept:* admin sets a main account on the Accounting page, settles from EOD without
  picking destinations, sees the rep's day go to zero, and finds the movement in the
  rep ledger — with nothing left under Settings.

**Phase 3 — ERP link check**
- [ ] Ensure main account `erp_account_code` set; confirm settlement posts a balanced
  journal (DR main / CR box), retry-idempotent.

## Verify gate
Backend: `npm run build` + `npm test`. Frontend:
`npm run typecheck && npm run lint && npm run build && npm test`.
