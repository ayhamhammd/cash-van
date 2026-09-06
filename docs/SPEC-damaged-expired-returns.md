# Damaged / Expired Returns — Specification

Track the goods a salesman returns as **damaged** or **expired** as a *separate*
inventory (not re-sellable van stock), surface them in a dedicated report and in
the rep's daily close / reconciliation, and gate the whole behaviour behind a new
**Program Features / Activation** settings screen.

> **Status:** specification + Phase 1 (the activation flag) implemented. Later
> phases are staged below; each is independently shippable.

---

## 1. Why

A cash-van rep carries stock. Some comes back from customers **damaged** or
**expired**. Today a RETURN posts `in` (sign `+1`) and re-adds the goods to the
rep's **sellable** van stock — which is wrong for damage/expiry: those units must
be quarantined, counted separately, and reconciled at settlement, not re-sold.

## 2. Scope (what the client asked for)

1. When a rep makes a **return**, the returned item is handled as configured in the dashboard.
2. On a damaged/expired return the **only** reasons offered are **"تالف" (damaged)** and **"منتهي الصلاحية" (expired)**.
3. The inventory report shows **damaged & expired items as a separate inventory** (a quarantine bucket, per rep).
4. A **new dashboard report — "تقرير الكميات التالفة للمندوبين" (Damaged Quantities Report for Sales Representatives)** — lists these items, printable.
5. The rep's **daily closing statement (End-of-Day)** shows the damaged quantity.
6. The **reconciliation page** gets a **separate column** for damaged/expired.
7. All of this is switched on from a **new settings screen** for activating program features/permissions.

---

## 3. Data model

### 3.1 Feature flag (Phase 1 — implemented)
`app_settings.damaged_returns_enabled BOOLEAN NOT NULL DEFAULT false`
(entity `damagedReturnsEnabled`). Exposed on `GET /settings` and settable via
`PATCH /settings`. Everything below is a no-op until this is on.

### 3.2 Damaged stock bucket
A rep's damaged/expired units are a **pool keyed by (rep, item, pool, reason)**,
never mixed with sellable van stock. Two equivalent options — pick one at build:

- **A. Reason-tagged movement (recommended):** keep the return as a voucher but,
  when reason ∈ {DAMAGED, EXPIRED} and the flag is on, post it to a per-rep
  **damaged warehouse** (a `warehouses` row flagged `is_damaged`, one per van or
  one shared "DAMAGED" store) instead of the sellable van store. The van's
  sellable balance is untouched; the damaged store accrues the units.
- **B. Dedicated table:** `damaged_stock (org_id, rep_id, item_number, stock_unit_code, reason, qty, source_voucher_number, created_at)`, written when such a return posts. Simpler to report, but a second stock ledger to keep honest.

Recommended: **A** — it reuses the posting engine, the ERP mirror, and existing
stock reads; the damaged store is just another warehouse the reports filter on.

### 3.3 Return reason on the voucher
Persist the machine reason (`DAMAGED` | `EXPIRED` | …), not just the Arabic
label, so reports and the posting reroute can act on it.

> **Phase-4 finding (2026-09):** the backend does **not** persist a return's
> reason at all today — `voucher_headers` has no `notes`/`reason` column and
> `CreateVoucherDto` has no reason field; the Arabic reason lives only on the
> *app's* local invoice (its `notes`). So this is not a one-column add — it must
> be threaded end-to-end:
> 1. **App** — persist the machine reason on the invoice (**Room DB migration**)
>    and send it in the upload (`CreateVoucherRequest.returnReason`).
> 2. **BE** — `CreateVoucherDto.returnReason` → `voucher_headers.return_reason`
>    (migration) → stored in `vouchers.create()`.
> 3. **BE** — `damaged_stock` ledger + a **guarded reroute in `post()`** (skip the
>    sellable van `applyLineToVan('in')` for damaged/expired; write the ledger).
> 4. **ERP mirror** — the `SALES_RETURN` push must target the damaged bucket, not
>    the van, or it re-inflates sellable stock ERP-side.
>
> This is a stock-critical, two-repo change (incl. a mobile DB migration) that
> should land as its **own** unit and be exercised on the test DB before 94 —
> not folded into an unrelated batch.

---

## 4. Behaviour by surface

### 4.1 Mobile (FlowVan)
- **Return reasons:** when `damagedReturnsEnabled`, the reason chips are limited to
  **DAMAGED** and **EXPIRED** (`ReturnReason` today also has WRONG_ORDER, OTHER).
  The flag reaches the app via `GET /company-info` / app settings sync.
- The return still uploads its payment line (see the settlement fix) and now also
  its **machine reason**; a damaged/expired return must NOT increase sellable van
  stock (the server routes it to the damaged bucket per §3.2).

### 4.2 Backend
- **Posting:** a RETURN with reason ∈ {DAMAGED, EXPIRED} and the flag on posts to
  the damaged bucket, not the van's sellable pool.
- **New report endpoint** `GET /reports/damaged-quantities?from&to&repId` →
  rows `{ repId, repName, itemNumber, itemName, reason, qty }` (+ totals),
  rep-scoped like the other reports, gated by a `reports.damaged` permission key.
- **End-of-Day** (`reports.service.eod`/settlement): add `damagedQty` (count of
  damaged/expired units in the period) to `EodRow` and the settlement row/entity.
- **Inventory report:** the damaged store shows as its own inventory line.

### 4.3 Dashboard (frontend)
- **New report tab** "التالف/المنتهي" rendering the damaged-quantities report,
  with print (reuse the `window.print()` pattern) — the "Damaged Quantities Report
  for Sales Representatives".
- **End-of-Day view:** show the damaged quantity per rep.
- **Reconciliation page:** a new **column** for damaged/expired quantity.
- **New settings screen — "تفعيل مزايا البرنامج / Program Features"** (Phase 1 UI):
  a screen under Settings that activates program features/permissions; its first
  control is the **Damaged & expired returns** toggle (`damagedReturnsEnabled`).

---

## 5. Permissions
- `reports.damaged` — view the damaged-quantities report (deny-by-default, like the
  other `reports.*` keys; admins pass).
- The activation screen itself is `<Can role="admin">` (settings are admin-only).

---

## 6. Implementation phases

1. **Activation flag (done):** `app_settings.damaged_returns_enabled` +
   migration + DTO + settings GET/PATCH.
2. **Settings screen:** new "Program Features" settings tab exposing the toggle
   (FE) — the screen the client asked for.
3. **Reason capture + machine reason:** `voucher_headers.return_reason`; app sends
   it; app limits reasons to DAMAGED/EXPIRED when the flag is on.
4. **Damaged bucket + posting:** damaged store (`warehouses.is_damaged`) or
   `damaged_stock`; route damaged/expired returns there; inventory report shows it.
5. **Report + EOD + reconciliation:** `GET /reports/damaged-quantities`, the
   dashboard report tab (+ print), the EOD damaged quantity, the reconciliation
   column, and `reports.damaged`.
6. **APK + 94 image:** ship the app + the BE/dashboard bundle.

---

## 7. Files (per phase)

| Phase | Backend | Frontend | Mobile |
| ----- | ------- | -------- | ------ |
| 1 | `app-settings.entity.ts`, `settings.service.ts`, `update-settings.dto.ts`, new migration | — | — |
| 2 | — | new `ProgramFeaturesTab`/screen + settings API field + i18n | — |
| 3 | migration `voucher_headers.return_reason`, sync/vouchers ingest | — | `ReturnVoucherContract` (reason filter), `LocalSyncMappers` (send reason) |
| 4 | posting engine (`vouchers.service` STOCK_DIRECTION / store resolution), warehouses | inventory report line | — |
| 5 | `reports.service` (+ new endpoint, EOD field), `reports.controller`, permissions | reports tab + print, EOD column, reconciliation column | — |

---

## 8. Rules to get right
- **Off by default** — `damagedReturnsEnabled=false` changes nothing; every branch checks it.
- **Damaged units never re-enter sellable stock** — that is the whole point (§3.2).
- **Reason is machine-typed** — filter/report on `DAMAGED`/`EXPIRED`, not the Arabic label.
- **Rep-scoped** — the report and columns honour `RepScopeService` like every other report.
- **ERP mirror** — if a damaged return still posts a voucher, the ERP push must target the damaged store, not the van, or it will re-inflate sellable stock on the ERP side.
