# SPEC — End-of-Day Closing: Rep Cash Accounts & Settlement Transfers

Turn End-of-Day closing into a full **cash-account (box) feature**. Every salesman has a
**sales cash box** that fills up as he sells (cash sales only); collections and cheques
fill **separate boxes**. When the admin **settles** a rep, all three boxes are **emptied
and transferred** into company accounts the admin **chooses at settle time** — recorded
as transfer entries **visible to admins on the dashboard only**, and posted to the
**ERP as journal entries** (each dashboard account maps to an ERP GL account).

Status: **proposal — approved decisions baked in**. Extends the existing EOD stack
(`SalesmanSettlement`, `POST /reports/end-of-day/settle`, EOD lock, ERP
`cash-settlements` push). Complements [end-of-day report](SPEC-end-of-day-report.md) and
[accounts receivable](SPEC-accounts-receivable.md). Money is **fils** throughout the
dashboard; the ERP v1 API speaks major decimals.

---

## 1. Decisions (locked with the product owner, 2026-07-08)

1. **Destination account is chosen per settlement** — at settle time the admin picks
   which company account receives each box (from the accounts registry in Settings).
   "Daily / weekly" is a naming convention of the accounts the admin creates (e.g.
   "Daily Sales Account", "Weekly Sales Account"), not hardcoded system accounts.
2. **Transfer entries are admin-only** — settlement transfer entries appear in the
   dashboard account ledgers (manager/admin RBAC). They do **not** appear to the rep and
   never mix into customer collections or sales figures.
3. **One settle action empties all three boxes** — sales cash → chosen sales account,
   collection cash → chosen receipts account, cheques → chosen cheque account.
4. **Accounts map to ERP GL accounts** — every dashboard account links to an ERP
   chart-of-accounts id; a settlement posts a **journal entry** in the ERP
   (DR destination account / CR rep box account).

---

## 2. Concepts & data model (dash-api)

### 2.1 `cash_accounts` — the account registry

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `code` | text unique | e.g. `REP-101-SALES`, `MAIN-DAILY` |
| `name` | text | display, e.g. "حساب المندوب جهاد — مبيعات" |
| `kind` | text | `REP_SALES` \| `REP_RECEIPTS` \| `REP_CHEQUES` \| `COMPANY` |
| `rep_id` | uuid nullable | owner rep; **null = shared/combined** account |
| `erp_account_id` | text nullable | linked ERP chart-of-accounts id (GL mapping) |
| `erp_account_code` | text nullable | snapshot of the ERP account code/name for display |
| `is_active` | bool | |
| timestamps | | |

**Combined-vs-separate rule (the Settings choice):** a rep's box is resolved as
*their own account of that kind if one exists, else the shared account of that kind
(`rep_id IS NULL`)*. That single rule implements "a representative can be linked to a
separate account or all accounts combined into one" — for sales, receipts and cheques
independently.

### 2.2 `account_transactions` — the ledger

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | uuid FK → cash_accounts | |
| `entry_kind` | text | `SALE` \| `COLLECTION` \| `CHEQUE` \| `SETTLEMENT_OUT` \| `SETTLEMENT_IN` |
| `amount_fils` | bigint signed | + into the account, − out |
| `label` | text | e.g. **"مندوب المبيعات جهاد" / "Sales Representative Jehad"** |
| `rep_id` | uuid nullable | which rep generated it |
| `ref_type` / `ref_id` | text / text | `voucher` \| `collection` \| `settlement` + id |
| `settlement_id` | uuid nullable | groups the transfer pair |
| `created_at` | timestamptz | |

Balances are **derived** (`SUM(amount_fils)` per account) — no stored balance to drift.
Index `(account_id, created_at)` and `(settlement_id)`.

### 2.3 Feeding the boxes (automatic entries)

| Trigger | Entry | Box |
|---|---|---|
| **Cash SALE voucher posted** (payment_type = CASH; CHEQUE/TRANSFER/CARD sale lines count as cash sales per EOD convention — confirm §8.1) | `SALE`, +netTotal, label "Sales Representative [name]" | rep **sales** box — **only sales, nothing else** |
| **Collection confirmed, method=cash** | `COLLECTION`, +amount | rep **receipts** box |
| **Collection confirmed, method=cheque** | `CHEQUE`, +amount | rep **cheques** box |
| Credit sales | **never** enter any box (they are AR, not cash) | — |
| Cash RETURN posted | `SALE`, −returnTotal | rep sales box (cash went back out) |

Hook points: `VouchersService` post path + `CollectionsService` confirm path (events
already exist). Entries are idempotent per ref (`unique (ref_type, ref_id, entry_kind)`).

### 2.4 Settlement = empty the boxes (extends existing settle)

`POST /reports/end-of-day/settle` gains a `transfers` block:

```jsonc
{
  "repId": "…", "from": "2026-07-08", "to": "2026-07-08", "receivedFils": 123450,
  "transfers": {
    "salesAccountId":    "…",   // destination for the sales box (required if box > 0)
    "receiptsAccountId": "…",   // destination for the receipts box
    "chequesAccountId":  "…"    // destination for the cheques box
  }
}
```

For each non-empty box, inside one DB transaction:
1. `SETTLEMENT_OUT` −balance on the rep's box (label "تسوية — [rep]"),
2. `SETTLEMENT_IN` +balance on the chosen destination account,
3. both rows stamped with the new `salesman_settlement.id`.

The rep's boxes read **zero** after settlement; the existing settlement record, EOD lock
and history behave exactly as today. Destination accounts are remembered as defaults for
the next settlement of that rep (nice-to-have).

### 2.5 ERP journal posting

On settle, queue **one ERP journal entry per box transfer** through the outbox
(replacing/extending today's `cash-settlements` push):

```
DR  destination.erp_account_id     amount
CR  repBox.erp_account_id          amount
memo: "EOD settlement [rep] [period]"   idempotency: settlementId + boxKind
```

**ERP v1 additions needed (Phase 3):**
- `GET /api/v1/chart-of-accounts` (scope `accounting:read`) — id, code, name, type;
  powers the account-picker in dashboard Settings.
- `POST /api/v1/journal-entries` (scope `accounting:write`, idempotent) — validated
  balanced journal, posted via the existing PostingEngine.
- Boxes with no `erp_account_id` skip the ERP post (dashboard-ledger only) with a
  visible "not GL-linked" badge — the feature still works without the mapping.

---

## 3. API surface (dash-api, all manager/admin RBAC)

| Method / path | Purpose |
|---|---|
| `GET /v1/cash-accounts` | list accounts (+ derived balance each) |
| `POST /v1/cash-accounts` | create (kind, name, repId?, erpAccountId?) |
| `PATCH /v1/cash-accounts/:id` | rename / relink ERP account / activate |
| `DELETE /v1/cash-accounts/:id` | only when balance = 0 and no entries |
| `GET /v1/cash-accounts/:id/transactions?from&to&kind` | ledger of one account |
| `GET /v1/cash-accounts/rep/:repId/summary` | the rep's 3 boxes + balances (settle dialog) |
| `GET /v1/erp/chart-of-accounts` | proxy of the ERP CoA list (for the picker) |
| `POST /reports/end-of-day/settle` | **extended** with `transfers` (§2.4) |

---

## 4. Dashboard UI

### 4.1 End-of-Day page → tabs

- **Tab 1 — تقفيل اليوم (existing)**: the EOD table as today; the settle dialog gains
  three **destination account pickers** (pre-filled with last-used / defaults) and shows
  each box's current balance.
- **Tab 2 — حسابات المناديب (rep accounts)**: pick a rep (or "all") → ledger of the rep's
  **sales box**: entries titled "مندوب المبيعات [الاسم]" with date, amount, running
  balance. **Only sales entries appear here** (+ settlement outs). Header shows current
  box balance.
- **Collections box within the tab**: a second panel on Tab 2 listing the rep's
  **receipts box** and **cheques box** entries (collections/cheques + their settlement
  outs), each with its balance — kept visually separate from the sales box per the
  requirement.

### 4.2 Settings → صناديق و حسابات (Accounts page)

- Table of all cash accounts: name, kind, owner rep (or "مشترك/combined"), ERP GL link,
  balance, active.
- **Create account** drawer: kind (rep sales / rep receipts / rep cheques / company),
  optional rep (empty = combined/shared), name, ERP account picker (from
  `/v1/erp/chart-of-accounts`).
- Quick action **"أنشئ صناديق لكل مندوب"** — bulk-create the three per-rep boxes for
  every active rep that lacks them; or leave reps unassigned to use the shared boxes.
- RBAC: admin only.

Everything bilingual via the flat `t()` dictionary; money rendered with `formatJOD`.

---

## 5. Mobile app

**No app changes required.** The boxes/transfers are an admin-side ledger (Decision 2:
admin-only visibility). The rep keeps seeing today's cash figure and the existing EOD
lock exactly as now. (If later you want the rep to see "his box balance", it is one
read-only endpoint reusing `rep/:repId/summary`.)

---

## 6. Phased plan & acceptance

**Phase 1 — dash-api core**
- [ ] `cash_accounts` + `account_transactions` migrations (+ unique ref index)
- [ ] auto-entries: cash-sale post → sales box; collection confirm → receipts/cheques box; cash return → −sales box
- [ ] box resolution rule (own account else shared) + `rep/:repId/summary`
- [ ] settle extension: `transfers` block, transfer pairs in one tx, boxes read zero after
- [ ] accounts CRUD + ledger endpoints
- ✅ *Accept:* posting a cash sale raises the rep's sales box; a confirmed cheque raises the cheque box; settling with chosen accounts zeroes all boxes and writes paired entries.

**Phase 2 — dashboard FE**
- [ ] Settings → Accounts page (create/link, ERP picker, bulk per-rep boxes)
- [ ] EOD tabs: rep-account ledger ("Sales Representative [name]", sales only) + collections/cheques boxes panel
- [ ] settle dialog account pickers with box balances
- ✅ *Accept:* admin creates accounts, settles a rep choosing destinations, and sees the transfer entries in both ledgers; rep sees nothing new.

**Phase 3 — ERP GL**
- [ ] `GET /api/v1/chart-of-accounts` + dashboard proxy
- [ ] `POST /api/v1/journal-entries` (PostingEngine, idempotent on settlementId+box)
- [ ] outbox: settlement → journal per box (skip unlinked boxes)
- ✅ *Accept:* a settlement produces balanced ERP journals DR destination / CR rep box; retrying the outbox never duplicates.

---

## 7. Compatibility & migration

- The existing EOD math (`expectedCashFils`, `previousBalanceFils`, settlement history,
  EOD lock, ERP `cash-settlements` push) is **unchanged**; boxes are additive. The old
  `cash-settlements` push is retired only in Phase 3 when journals replace it.
- **Feature start = zero balances.** Boxes begin empty at deploy; no backfill of
  historical vouchers (avoids double-counting money already settled). Note in release.
- If a box has no account (no per-rep account and no shared one), the entry is **held**:
  the voucher/collection is unaffected, a warning appears on the EOD page, and entries
  are written once the account exists (re-derivable since balances come from refs).

## 8. Open questions (non-blocking)

1. **Cheque/transfer/card SALE lines** — EOD today counts only `payment_type='CASH'` as
   cash sales. Do CHEQUE/TRANSFER/CARD sale payments enter the sales box, the cheque box,
   or stay out of boxes entirely? (Spec assumes: CASH-only into the sales box.)
2. **Weekly roll-up** — is a "weekly account" just an account the admin picks on Fridays,
   or do you want an automatic weekly sweep from a daily account into a weekly one?
3. **Received vs expected** — settlement stores `receivedFils` (what the admin actually
   took). Should the transfer move the **box balance** (expected) or the **received**
   amount, with the shortfall staying in the rep's box as carried debt? (Spec assumes:
   transfer = box balance; shortfall handling stays in `new_balance_fils` as today.)
