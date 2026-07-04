# Collections Page Revamp — Spec

> **Status: ✅ IMPLEMENTED (2026-07-03).** All 5 changes shipped + verified E2E.
> Open decisions resolved: banks = static list served by `GET /reference/banks`
> (+ "Other" free-text); ERP receipt = one **summed** payment (`col.amount = Σ`),
> per-cheque breakdown stays FlowVan-side. **No migration needed** — `cheques.collection_id`
> had only a non-unique index, so it already allowed N cheques per collection; the
> change was entity relation (`@OneToOne`→`@OneToMany`/`@ManyToOne`) + DTO/service only.


Changes to the **Collections** page (web dashboard) and the backend that supports it.
Five asks:

1. Remove the **Aging** view.
2. Show **customer name** and **salesman name** in the collections list.
3. Add **filters**: salesman, customer, and date.
4. Turn the **"Record payment"** dialog into a **full page**; customer and salesman
   are chosen via a **searchable picker dialog**.
5. For **cheque** receipts: pick the **bank from a dropdown**, allow **multiple
   cheques on one receipt**, and make the **receipt total = sum of the cheques**.

Money is integer **fils** end to end (`formatJOD` at render). Bilingual AR/EN, RTL.

---

## 0. Current state (grounded)

**Backend** (`src/modules/collections/`)
- `GET /collections` (`collections.service.list`) already filters by `repId`,
  `customerId`, `method`, `status`, `from`, `to`, `limit`, `offset` — but returns the
  **raw `Collection` entity with no names** joined.
- `Collection`: `{ id, repId, customerId, collectionNumber, invoiceId, paymentId,
  amount(fils), method('cash'|'cheque'), status, collectedAt, confirmedAt,
  depositedAt, note }` + **`@OneToOne` `cheque`**.
- `Cheque`: `{ id, collectionId, bankName(free text, nullable), chequeNumber, amount,
  amountWords, dueDate, status, wordsMatch, … }` — **one cheque per collection**
  (`collection_id` unique via OneToOne).
- `POST /collections` (`CreateCollectionDto`) takes one optional `cheque` object; the
  service sets `cheque.amount = collection.amount`.
- `GET /collections/aging` → `AgingReport` (uncleared-cheque buckets).
- No **bank master list** anywhere (bank is free text).

**Frontend** (`src/features/collections/`)
- `CollectionsView.tsx`: stat cards, an **Aging** card (`useCollectionAging`), a cheque
  reconcile-queue card, and a `DataTable` with columns **Date / Amount / Method /
  Status** (no names, no filter UI).
- `RecordCollectionModal.tsx`: a `Modal` with rep `<select>`, customer `<select>`,
  amount, method, and a **single** free-text `bankName` + `chequeNumber`.
- `api.ts`: `Collection`, `AgingReport`, `CreateCollectionInput` (single `cheque`).

---

## 1. Remove the Aging view

**Frontend only.**
- Delete the Aging `Card` from `CollectionsView.tsx` and the `useCollectionAging`
  call. Remove `AgingReport`/`AgingBucket`/`useCollectionAging` from `api.ts`.
- Re-flow the top of the page: keep the stat cards + cheque reconcile-queue card.
- **Backend:** leave `GET /collections/aging` in place (harmless, possibly used by
  the app) but mark it unused by the web. Drop the frontend `endpoints.collections.aging`
  only if nothing else references it.

---

## 2. Customer name + salesman name in the list

**Backend** (`collections.service.list`)
- Join `customers` (on `customer_id`) and `reps` (on `rep_id`) and return an enriched
  row. Prefer a QueryBuilder (or a raw SQL `LEFT JOIN`, positional params) over the
  entity `findAndCount`, since we now need joined columns:
  ```
  customerName  = customers.name_ar (fallback customer_name / customer_number)
  customerNumber
  repName       = reps.name_ar (fallback name_en / code)
  repCode
  ```
- Extend the list response item to `Collection & { customerName, customerNumber,
  repName, repCode }`. Keep pagination `{ items, total }`.

**Frontend**
- Add `customerName/customerNumber/repName/repCode` to the `Collection` type.
- New columns after **Date**: **Customer** (name + number sub-line) and **Salesman**
  (name + code sub-line). Order: Date · Customer · Salesman · Amount · Method · Status.

---

## 3. Filters: salesman, customer, date

The backend query already accepts `repId`, `customerId`, `from`, `to` — **no backend
change** beyond #2. Add the **frontend filter bar** (a `Card` above the table):

- **Salesman**: searchable picker (reuse the picker from #4) → sets `repId`.
- **Customer**: searchable picker → sets `customerId`.
- **Date**: `from` / `to` date inputs (default: current month; empty = all).
- A "Clear" button; the active filters feed `useCollections({ repId, customerId,
  from, to, method?, status? })`. Also keep the existing **method**/**status** as quick
  chips (optional, they already work).
- Show a result count and reset paging to offset 0 on any filter change.

---

## 4. Full-page "Record payment" + searchable pickers

Replace the modal with a **route**: `/(dashboard)/collections/new` →
`RecordCollectionView` (client component). "Record payment" button navigates there;
after save, navigate back to `/collections` and invalidate the list.

**Layout** (single column, wide form):
1. **Customer** — a read-only field showing the picked customer; clicking it opens a
   **searchable dialog** (`Modal` + search input hitting `useCustomers({ q, limit })`,
   list of results, click to select). Shows name + number + outstanding balance if
   available.
2. **Salesman** — same pattern, `useReps({ q, limit })`.
3. **Date** (`collectedAt`), optional **invoice link**, **note**.
4. **Method** toggle: **Cash** | **Cheque**.
   - Cash → a single **amount** field.
   - Cheque → the **multi-cheque editor** (see #5); amount is derived.
5. Sticky footer: **Save** (disabled until valid) + **Cancel**.

**Reusable component:** `EntityPickerDialog<T>` (search box + result rows + onSelect) —
built once, used for both customer and salesman (and reused by the #3 filters). Lives in
`src/features/collections/` or `src/components/ui/` if generic enough.

`RecordCollectionModal.tsx` is removed (or kept as a thin wrapper that redirects).

---

## 5. Cheque receipts: bank dropdown + multiple cheques

### 5a. Bank dropdown
- Introduce a shared **bank list**. Decision: **static curated list of Jordanian banks**
  (`Bank Al Etihad`, `Arab Bank`, `Housing Bank`, `Cairo Amman Bank`, `Jordan Kuwait
  Bank`, `Jordan Islamic Bank`, `Bank of Jordan`, `Capital Bank`, `Jordan Ahli Bank`,
  `Safwa Islamic Bank`, `Invest Bank`, `ABC Bank`, `Societe Generale`, `Jordan Commercial
  Bank`, …) with an **"Other → free text"** escape hatch.
  - Serve it from a tiny **`GET /reference/banks`** (returns `{ code, nameAr, nameEn }[]`)
    so web + app + any validation share ONE source; the frontend has a matching
    `JORDAN_BANKS` constant fallback for offline.
  - `bankName` stays free text on the `Cheque` entity (store the chosen display name);
    optionally add `bank_code` later. No entity change required for the dropdown.

### 5b. Multiple cheques per receipt (structural)
Today a collection has **one** cheque (`@OneToOne`). Change to **one collection →
many cheques**, receipt amount = **Σ cheque amounts**.

**Schema / migration** (`…-CollectionMultiCheque`):
- `cheques`: keep `collection_id`, but change the relation to **`@ManyToOne`**
  (drop the one-to-one uniqueness on `collection_id`; add a plain index).
- `Collection`: `@OneToOne cheque` → **`@OneToMany cheques`**.
- Each **cheque already has its own `amount`** column — good; it becomes per-cheque.
- Backfill is a no-op (existing rows already 1:1).

**Create DTO** (`CreateCollectionDto`):
- Replace `cheque?: ChequeInputDto` with `cheques?: ChequeInputDto[]`.
- Add a required **`amount`** to `ChequeInputDto` (fils, ≥1) — each cheque's own value.
- Validation when `method='cheque'`:
  - `cheques` non-empty;
  - **server sets `collection.amount = Σ cheques[].amount`** (ignore/verify any
    client-sent top-level amount to avoid drift);
  - each cheque needs bank + number + dueDate (bank from the list or "Other" text).
- `method='cash'` → `amount` required, `cheques` forbidden.

**Service** (`collections.service.create`): create the collection, then insert N
`Cheque` rows (each with its own amount/bank/number/dueDate/words). Words-mismatch
handling stays **per cheque** (a mismatched cheque blocks confirm of the whole receipt).

### 5c. Multi-cheque frontend editor
- In `RecordCollectionView`, when method = Cheque, render a **repeating cheque row**:
  `bank (dropdown + Other)`, `cheque #`, `amount (fils↔JOD)`, `due date`, optional
  `amount in words`. "**+ Add cheque**" appends a row; each row removable.
- **Receipt total** = live sum of the rows (read-only, prominent). Save sends
  `{ method:'cheque', cheques:[…] }`; the server recomputes the total.

### 5d. Downstream impacts to update (flag + handle)
- **Collection detail / list "Method" + amount**: a cheque collection may now show
  "Cheque ×N". Detail view lists each cheque (bank, #, amount, due, status).
- **Cheque reconcile queue / `GET /cheques`**: already per-cheque — now naturally shows
  multiple rows per collection; verify links still resolve (`collectionId`).
- **ERP outbound** (`erp-outbox.service` `buildPayment`): a collection → ERP receipt.
  Confirm the ERP receipt still maps by collection amount (Σ) — the ERP receives one
  payment of the summed amount; the per-cheque breakdown is FlowVan-side. Flag if the
  ERP needs per-cheque lines.
- **Collection summary** (`summary`): `chequeFils` should sum all cheques; re-check the
  aggregate query after the relation change.
- **Edit** (`update-collection.dto` / `PATCH /collections/:id`): mirror the array shape;
  editing a confirmed/deposited receipt stays blocked as today.

---

## 6. Deliverables checklist

**Backend**
- [ ] `list()` joins customer + rep names → enriched list items (#2).
- [ ] `GET /reference/banks` (static Jordan banks) (#5a).
- [ ] Migration: cheque `@ManyToOne` collection; `Collection.@OneToMany cheques` (#5b).
- [ ] `CreateCollectionDto`: `cheques[]` + per-cheque `amount`; server sums to
      `collection.amount`; cash/cheque validation (#5b).
- [ ] `create()` inserts N cheques; `summary`/reconcile/ERP push reviewed (#5d).

**Frontend**
- [ ] Remove Aging card + `useCollectionAging`/types (#1).
- [ ] `Collection` type + Customer/Salesman columns (#2).
- [ ] Filter bar: salesman + customer pickers + date range (#3).
- [ ] `EntityPickerDialog` (search) reused for pickers + filters (#3/#4).
- [ ] `/collections/new` full-page `RecordCollectionView`; remove the modal (#4).
- [ ] Bank dropdown (`JORDAN_BANKS` + "Other") (#5a).
- [ ] Multi-cheque editor with live receipt total (#5c).
- [ ] `CreateCollectionInput` → `cheques[]`; i18n AR/EN for all new strings.
- [ ] Verify gate: `typecheck && lint && build && test`.

---

## 7. Suggested order

1. **Backend #2 + #3** (names + already-present filters) — unblocks the list UI.
2. **Frontend #1 + #2 + #3** (remove aging, names, filter bar) — independent, low risk.
3. **Backend #5b/#5c** (multi-cheque schema + DTO + service) + **`/reference/banks`**.
4. **Frontend #4 + #5** (full-page record, pickers, bank dropdown, multi-cheque editor).
5. Review #5d downstreams (summary, reconcile, ERP push) and verify end-to-end.

---

## 8. Open decisions

- **Banks source:** static list + `/reference/banks` (recommended) vs a full `banks`
  table admins manage. Start static; promote to a table only if editing is needed.
- **ERP receipt granularity:** one summed receipt (recommended, current behavior) vs
  per-cheque lines on the ERP side — confirm with the ERP payments API.
- **Cash + cheque on one receipt:** out of scope (method is single-choice). If needed
  later, generalize `method` to line-level tenders.
