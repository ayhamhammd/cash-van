# F11 — Operations Hub (العمليات): replace the Vouchers tab

**Repos:** `cash-van-dashboard-frontend` (main work) + `cash-van-dashboard` (small deltas).
**Effort:** M–L (≈ 3–4 dev-days). **Status:** spec ready — see PROGRESS.md.
**Written for an implementing agent** — file paths, behavior matrix and acceptance criteria
are exact; follow the frontend CLAUDE.md verify gate (`typecheck && lint && build && test`).

## 1. Goal

Remove the current **السندات / Vouchers** nav item and replace it with one operations
center: **العمليات (Operations)** — a single page with three sub-tabs that fully implement
every voucher kind with the correct stock-dependency rules:

| Sub-tab | Kinds | Stock rule |
|---|---|---|
| **المبيعات** (Sales) | SALE · RETURN · ORDER | SALE: needs from-store qty · RETURN: adds back, no qty check · ORDER: **no qty dependency at all** |
| **حركة المخزون** (Stock movement) | TRANSFER · IN · OUT | TRANSFER: needs **from-store** qty only (to-store irrelevant) · IN: no qty check · OUT: needs store qty |
| **المشتريات** (Purchases) | PURCHASE | adds stock in; carries **vendor + the vendor's own invoice number** |

Sales/Return/Order vouchers created from the dashboard are **always posted immediately**
(`isPosted: true`) — the dashboard user is a manager; the F10 approval gate only applies to
salesmen, so no approval step appears here.

## 2. Current state (read before coding)

### Backend (`src/modules/vouchers/vouchers.service.ts`)
- `create()` already: computes per-line totals, resolves stock movement per line sign, and
  **guards only lines that have a `fromStoreNumber`** with
  `Not enough stock of {item} in store {store}` (~line 232–250).
  - SALE / OUT / TRANSFER-from → guarded ✓ (matches the table above — keep).
  - IN / RETURN → only `toStoreNumber` → **no guard** ✓ (already correct).
  - TRANSFER → one line carries `fromStoreNumber` + `toStoreNumber`; only the from side is
    checked ✓ (already correct — *to*-store balance is never consulted).
- `VOUCHER_PREFIX` already maps all kinds (INV/RET/ORD/PUR/IN/OUT/TRF…).
- `fulfill(id)` exists: ORDER-only, must be posted, idempotent via `is_fulfilled`.
- `CreateVoucherDto` already has `vendorNumber`, `referenceVoucherNumber`, per-line
  `fromStoreNumber`/`toStoreNumber`/`storeNumber`, unit fields, payments.
- ⚠ Heads-up: this file contains a **literal NUL byte** used as a map-key separator —
  `grep` treats it as binary; use `grep -a`.

### Backend deltas required (small)
1. **ORDER must not touch stock at all.** Verify with a test: create+post an ORDER whose
   qty exceeds the store balance → must succeed (sign 0 ⇒ no `fromStoreNumber` ⇒ no guard).
   If `resolveStockMovement` or the van-stock `reserve` effect blocks/fails when the rep/van
   has no stock row, relax: ORDER reserve is **best-effort** (skip when no van context) and
   never validates store qty. Document with a unit test either way.
2. **PURCHASE vendor invoice number.** Reuse `referenceVoucherNumber` as the *supplier's
   invoice number* for PURCHASE vouchers (validation only restricts RETURN references, so
   it passes today). Label it accordingly in Swagger
   (`description: 'RETURN: original SALE · PURCHASE: supplier invoice no.'`). No migration.
3. **Order→Sale linkage.** When the UI converts an order, it sends the new SALE with
   `referenceVoucherNumber = order.voucherNumber`. Accepted today with zero backend change;
   add it to the same Swagger description.
4. `GET /vouchers` already filters by `transKind` but only one kind — add support for a
   comma list (`transKind=SALE,RETURN,ORDER`, split server-side, `In(...)`) so each sub-tab
   is one query. Keep single-value behavior intact.

## 3. Frontend — structure

```
src/app/(dashboard)/operations/page.tsx            → <OperationsView/>
src/app/(dashboard)/operations/new/page.tsx        → <VoucherEditor/> (create, ?kind=&fromOrder=)
src/app/(dashboard)/operations/[id]/page.tsx       → <VoucherEditor/> (view/edit draft)
src/features/operations/
  OperationsView.tsx      — PageHeader العمليات + 3 sub-tabs + per-tab list
  VoucherList.tsx         — shared DataTable (kind chips, status, totals mono)
  VoucherEditor.tsx       — one form for ALL kinds (sections toggle per kind)
  LineItemsEditor.tsx     — product picker + qty/price/unit/store columns per kind
  api.ts                  — extend src/features/vouchers/api.ts or move it here
```

- **Delete** the `view.vouchers` nav item from `src/components/layout/nav.ts`; add
  `{ href: "/operations", labelKey: "view.operations", icon: "ArrowLeftRight" }` (add icon
  to `icons.ts`). Keep old routes `/vouchers*` as `redirect()` to `/operations` (links in
  the wild). Remove the old pages' content after migrating anything reusable from
  `src/features/vouchers/` (`VouchersView`, `VoucherForm` — salvage the line-builder logic).
- i18n: full `ops.*` key set (ar/en) — tab names المبيعات / حركة المخزون / المشتريات, all
  form labels, kind names (بيع/مرتجع/طلب/تحويل/إدخال/إخراج/مشتريات), and the convert button
  **"تحويل إلى سند بيع / Convert to sale voucher"**.

## 4. Frontend — behavior per kind (the heart of the feature)

`VoucherEditor` renders one form whose sections adapt to `kind`:

| Field / section | SALE | RETURN | ORDER | TRANSFER | IN | OUT | PURCHASE |
|---|---|---|---|---|---|---|---|
| Customer picker | ✔ | ✔ | ✔ | — | — | — | — |
| Vendor picker | — | — | — | — | — | — | ✔ (required) |
| Vendor invoice no. (`referenceVoucherNumber`) | — | — | — | — | — | — | ✔ text, mono |
| Original sale (`referenceVoucherNumber`) | — | ✔ required, picker of customer's SALEs | — | — | — | — | — |
| Line: store | `storeNumber` | auto from sale | `storeNumber` (informational) | `fromStoreNumber` + `toStoreNumber` (two selects) | `toStoreNumber` | `fromStoreNumber` | `toStoreNumber` |
| Line: qty validated against stock (client-side preflight) | ✔ from store | — | **never** | ✔ from-store only | — | ✔ store | — |
| Discounts/payments | ✔ | ✔ | — | — | — | — | optional |
| Post on save (`isPosted`) | true | true | true | true | true | true | true |

Client-side preflight = call `GET /items/balance/list` for touched items and warn inline
("متوفر: 12") *before* submit; the server guard remains the source of truth — surface its
400 message verbatim on failure.

**RETURN line caps:** when an original sale is selected, prefill its lines with max-qty =
sold qty and block exceeding it client-side (server enforces store match already).

**TRANSFER UX:** one from-store + one to-store select at the top applies to every line
(per-line override allowed in an "advanced" toggle). Balance hint shows **from-store**
availability only — never show or check the to-store.

### Convert ORDER → SALE (the key flow)
- In the Sales tab, ORDER rows (and the editor when viewing an order) show
  **تحويل إلى سند بيع** (only when `isPosted && !isFulfilled`).
- Click → `router.push('/operations/new?kind=SALE&fromOrder=' + order.id)` — **nothing is
  saved at this point**. `VoucherEditor` loads the order via `GET /vouchers/{id}` and
  prefills: customer, all lines (item, qty, unit, price), notes — fully editable, exactly
  like a hand-opened create form.
- A small banner shows "محوَّل من الطلب ORD-… / Converted from order".
- On save: `POST /vouchers` `{ transKind:'SALE', isPosted:true,
  referenceVoucherNumber: order.voucherNumber, … }`; on success call
  `PATCH /vouchers/{orderId}/fulfill` (releases the reservation, marks fulfilled), toast
  with the new INV number, navigate to the sales tab. If fulfill fails (e.g. already
  fulfilled by someone else) show the error but keep the created sale — never roll it back.
- Fulfilled orders show a green "تم التحويل" chip linking to the sale (find by
  `referenceVoucherNumber`).

## 5. Acceptance criteria

1. السندات gone from the sidebar; العمليات present; `/vouchers`, `/vouchers/new`,
   `/vouchers/[id]` redirect to `/operations`.
2. Each sub-tab lists only its kinds (one request via `transKind` comma list) with working
   pagination/search/kind chips.
3. SALE with qty > store balance → server 400 surfaced inline; same line shows the
   client-side "متوفر: N" hint *before* submit.
4. RETURN requires picking the original SALE; prefilled lines capped at sold qty.
5. **ORDER saves and posts regardless of any stock level** (test with qty 99999).
6. TRANSFER: blocked only by *from*-store shortage; to-store balance never consulted;
   after post, `item_balance` shows −from/+to.
7. IN posts with no qty constraint; OUT with qty > balance → 400.
8. PURCHASE requires a vendor; saves the supplier invoice number; after post the to-store
   balance increases.
9. Convert flow: order → button → prefilled unsaved editor → save → new INV posted +
   order `isFulfilled=true` + chip links both ways. Editing the prefilled data before
   saving works (it's a normal create form).
10. All money mono-LTR 3-decimals; full ar/en dictionary coverage; RTL correct.
11. Verify gate green in both repos; backend unit test for criterion 5 + comma-list filter.

## 6. Out of scope

Mobile changes (FlowVan keeps its own flows); approval workflow changes (F10 already
covers salesman gating); printing layouts; partial order fulfilment (all-or-nothing v1).
