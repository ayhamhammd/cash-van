# SPEC — Accounts Receivable (debt / ذمم) → ERP + Dashboard + FlowVan

Give the cash-van a real **accounts-receivable (AR)** flow: each customer has a **credit
limit**; **credit (on-account) vouchers consume it** and **collections restore it**; the
van **hard-blocks** a credit sale that would exceed the limit (the remedy is a **manager
raising the customer's limit**, which syncs down so the rep re-creates the voucher — no
on-van override); credit sales are **kept out of the day's cash**; and everyone can see a
**customer AR aging** view. The **ERP is the source of truth** for the balance; the
dashboard mirrors it and adds an **arrears / monthly-collection** widget; the van shows
**live balance when online, local DB when offline**.

Status: **proposal**. Complements [collections revamp](SPEC-collections-revamp.md),
[end-of-day report](SPEC-end-of-day-report.md), the ERP-sync service, and
[customer price lists](SPEC-customer-price-list.md). Money is **fils** on the FlowVan +
dashboard side; ERP stores **thousandths** (same thing) and its v1 API speaks **major
decimals**.

---

## 1. Goal / user stories

- A distributor sets a **credit limit** per customer in the ERP.
- A rep opens a customer on the van; the app shows **available credit = limit − current
  balance** (live from server when online, from the local DB when offline).
- The rep chooses **Credit (آجل)** for a sale. If `balance + saleTotal > creditLimit`,
  the app **blocks the sale** (hard stop). To proceed, a **manager raises the customer's
  credit limit** in the dashboard/ERP; the new limit **syncs to the van** and the rep
  **re-creates** the voucher. There is no override on the device.
- The credit sale **increases** the customer's balance and is **NOT** counted in the
  day's **cash** sales (it shows as credit sales, separately).
- The rep collects money later (receipt voucher / collection); that **decreases** the
  balance and restores available credit.
- Anyone (van rep, dashboard manager) can open an **AR aging** screen: receivables
  bucketed **Current / 1–30 / 31–60 / 61–90 / 90+**, with a **toggle** between aging by
  **due date** (issue + terms) and by **invoice date**.
- The dashboard's main tab gains an **arrears widget**: monthly collections vs.
  outstanding, highlighting customers **in arrears** or **with unsettled credit sales**
  (credit sold but no matching receipt).

---

## 2. Source of truth & data flow

```
                 credit sale (voucher)                receipt (collection)
   FlowVan  ───────────────────────────►  Dashboard  ─────────────────────►  ERP
   (local balance ±, offline-first)        (mirror + export)       (invoices.amountPaid,
        ▲                                        ▲                   AR ledger = TRUTH)
        │        live balance / aging            │   balance + aging  │
        └────────────────────────────────────────┴────────────────────┘
                        GET .../balance , GET .../aging
```

- **ERP owns the number.** Balance = `Σ(invoice.totalAmount − amountPaid)` over open
  invoices; already exposed at `GET /api/v1/customers/{id}/balance` and
  `.../by-code/{code}/balance` → `{ balance, creditLimit }`. We **add aging** there.
- **Dashboard mirrors** ERP balance onto `customer.totalDebt` (today static/unused) via
  the ERP-sync pull, and **re-exposes** balance + aging to the van through its own v1
  endpoints so the van has one base URL. It also **computes the arrears widget** from its
  own vouchers + collections (fast, local) and reconciles against ERP.
- **FlowVan** keeps its offline working balance (`CustomerEntity.balance`, already
  ±adjusted on sale/collection) as the **offline fallback**, and **refreshes from server**
  (per-customer, on customer open + on sync) when online. Server value **wins** on refresh.

> Design rule: the van never invents the authoritative balance — but it must be able to
> **enforce the limit offline** using the last-known balance + local unsynced deltas.

**Credit-limit changes** (the only "override"): a manager edits `customer.creditLimit` on
the dashboard customer screen (or in the ERP). ERP is the master; the dashboard pushes the
edit outbound (`erp.customer.updated`, already carries `creditLimit`) and the van picks up
the new limit on its next customer refresh/sync. The rep then re-creates the blocked
voucher. Limit edits should propagate promptly (webhook-nudged refresh preferred).

---

## 3. Part A — ERP (source of truth) — **Phase 1**

Drizzle schema in `ERP/src/db/schema.ts`; v1 API under `ERP/src/app/api/v1/`.

### 3.1 Schema

Already present: `customers.creditLimit` (thousandths), `invoices.paymentType`
(`CASH|CREDIT`), `invoices.amountPaid`, `invoices.status`, `invoicePayments`,
`financialTransactions`, `creditNotes`.

Add:

| Table.column | Type | Purpose |
|---|---|---|
| `customers.payment_terms_days` | int, default 30 | Net-N terms → drives due date for aging **and** the arrears flag |
| `customers.credit_hold` | bool, default false | Hard stop regardless of limit (blacklist) |
| `invoices.due_date` | date (nullable) | `issued_at + payment_terms_days`; stored for stable aging |

No override-audit table: an over-limit credit sale is a hard block, so nothing is posted to
override. The manager's remedy is editing `customers.creditLimit` (normal customer update).

> If `due_date` is undesirable to denormalize, compute it on the fly from
> `issued_at + customer.payment_terms_days`. Storing it survives later terms changes.

### 3.2 Credit-limit check (shared helper)

`ERP/src/lib/ar/credit-check.ts` — **implemented** (`checkCreditAvailable`, `getOpenBalance`):

```ts
// returns { allowed, reason, balance, creditLimit, available, addAmount }
checkCreditAvailable({ orgId, customerId, creditLimit, creditHold, addAmount }):
  addAmount <= 0     → allowed  (cash sale — never blocks)
  credit_hold        → BLOCK    (reason CREDIT_HOLD)
  creditLimit <= 0   → allowed  (reason NOT_ENFORCED — "unlimited / not configured";
                                 keeps existing 0-limit customers working. Use
                                 credit_hold to stop a customer entirely.)
  balance + addAmount > creditLimit → BLOCK (reason LIMIT_EXCEEDED)
```

> **Semantic decision:** `creditLimit = 0` (the column default, true for all legacy
> customers) means **not enforced**, not "zero credit". Enforcement kicks in only once a
> manager sets a **positive** limit. To hard-stop a customer regardless, set `credit_hold`.
> Balance = `Σ(totalAmount − amountPaid)` over non-voided invoices (thousandths).

Wire into `POST /api/v1/sales-invoices` (and the dashboard sales-order/invoice actions):
- if `paymentType === 'CREDIT'` and check fails → **HTTP 409**
  `{ code: 'CREDIT_LIMIT_EXCEEDED', balance, creditLimit, available }`. **Hard reject** —
  there is no override bypass. The remedy is raising `customers.creditLimit` (a normal
  customer update) and resubmitting.

### 3.3 Aging endpoint (new)

`GET /api/v1/customers/{id}/aging?basis=due|invoice&asOf=YYYY-MM-DD`
and `GET /api/v1/customers/by-code/{code}/aging?...` — scope `customers:read`.

```jsonc
{
  "customerId": "…", "customerCode": "…", "asOf": "2026-07-06",
  "basis": "due",                         // or "invoice"
  "creditLimit": 10000.0, "balance": 5300.0, "available": 4700.0,
  "buckets": {
    "current":   1200.0,                  // not yet due (basis=due) / age 0 (basis=invoice)
    "d1_30":     900.0,
    "d31_60":    1500.0,
    "d61_90":    700.0,
    "d90_plus":  1000.0
  },
  "invoices": [ { "invoiceNumber","issuedAt","dueDate","total","paid","open","ageDays","bucket" } ]
}
```

Aging basis:
- **`due`** — `ageDays = asOf − dueDate` (invoices not yet due land in `current`).
- **`invoice`** — `ageDays = asOf − issuedAt` (everything ages from issue).

Org-wide roll-up for the dashboard:
`GET /api/v1/ar/aging?basis=&asOf=&warehouseCode=&page=` → per-customer bucket rows +
totals. Scope `customers:read`.

### 3.4 Webhook

Extend the existing ERP→cashvan webhook ping so a **receipt / invoice change** triggers a
targeted balance re-pull for that customer (fall back to full re-pull as today).

---

## 4. Part B — Dashboard (mirror + arrears widget) — **Phase 2**

NestJS backend `cash-van-dashboard/src/modules/…`, React FE
`cash-van-dashboard-frontend`.

### 4.1 Backend

- **ERP-sync pull** (`erp-sync.service.ts`): pull `balance`, `creditLimit`,
  `paymentTermsDays`, `creditHold` per customer → write `customer.totalDebt`,
  `creditLimit`, `paymentTerms`, (new) `creditHold`. This makes `totalDebt` *live-ish*
  (today it is never updated).
- **New AR module** `src/modules/ar/`:
  - `GET /v1/ar/aging?basis=due|invoice&asOf=&warehouseId=&repId=` — proxy/cache of ERP
    org aging, joined with local customer names/reps. Van + FE both consume this (one
    base URL for the van).
  - `GET /v1/ar/customers/:customerNumber/aging?basis=` — single-customer aging.
  - `GET /v1/ar/customers/:customerNumber/balance` — `{ balance, creditLimit, available, creditHold }`,
    fresh from ERP when reachable, else last-mirrored value + `stale:true`.
  - `POST /v1/vouchers` credit path: **re-validate** the limit server-side on sync; if it
    fails → reject with `CREDIT_LIMIT_EXCEEDED` so the van can surface it. No override
    bypass — the voucher stays unsynced until the limit is raised (then the rep re-creates
    /resubmits).
- **EOD / cash separation**: already correct on the backend (`payment_type='CASH'` vs
  `'CREDIT'` split in `reports.service.ts`). No change needed server-side; the fix is on
  the **van** (§5.3).

### 4.2 Arrears / monthly-collection widget (dashboard main tab)

New card on the dashboard overview + a drill-in page `/ar` (or `/receivables`):

- **This month**: total **credit sold**, total **collected** (receipts), **net Δ balance**,
  **collection ratio** = collected / (opening AR + credit sold).
- **In arrears** list: customers **past their payment terms** — i.e. holding open credit
  receivables whose `dueDate < asOf` (`ageDays > 0` on the `due` basis; any overdue
  bucket). Not-yet-due credit balances are **not** arrears. Columns: customer, balance,
  overdue amount, oldest-bucket, days overdue, last receipt date, rep.
- **Monthly collection trend**: collected per month (last 6–12 months) — sourced from
  `collections` + EOD data already available.
- Filters: warehouse, rep, aging basis (due/invoice).

FE: new `ArAgingPage` (bucketed table + basis toggle + CSV export) and the overview card.
Reuse the collections/aging table components from the collections revamp where possible.
Localize via the existing flat `t()` dictionary (i18n sweep).

---

## 5. Part C — FlowVan (enforcement + live/offline) — **Phase 3**

KMP app `FlowVan/…`. Money in **fils**. Customer AR fields already exist on
`CustomerEntity` (`balance`, `overdueAmount`, `creditLimit`).

### 5.1 Live/offline balance

- Add `arVersion`/`balanceUpdatedAt` to `CustomerEntity`; add
  `GET /ar/customers/{code}/balance` + `/aging` to a new `ArApi`.
- On **customer open** (and on sync), if online → fetch balance/aging, overwrite local
  `balance`, `overdueAmount`, `creditLimit`; if offline → use local values, show a
  **"offline — last synced HH:mm"** badge.
- **Effective available credit (offline-safe):**
  `available = creditLimit − (serverBalance + Σ unsynced local credit sales − Σ unsynced local collections)`.
  This prevents a rep from blowing past the limit with several offline credit sales before
  the next sync.

### 5.2 Hard block (no on-van override)

In `CreateSaleVoucherUseCase` / `VoucherViewModel` credit path:
- compute `available` per §5.1; if `creditHold` or `saleTotal > available` → **block** the
  save with a clear message: `الحد الائتماني: X، المتاح: Y — يرجى مراجعة المدير لرفع الحد`
  ("credit limit X, available Y — ask the manager to raise the limit").
- **No override on the device.** The remedy is out-of-band: a manager raises the customer's
  `creditLimit` on the dashboard/ERP → the new limit syncs down (§2, webhook-nudged
  refresh) → the rep re-opens the customer and **re-creates** the voucher, which now
  passes.
- Backend + ERP re-validate on sync (§3.2, §4.1); an over-limit voucher is rejected and
  surfaced back to the rep as a sync error until the limit is raised.

### 5.3 Keep credit out of the day's cash

`DailyKpi` today lumps all SALE totals together. Split it:
- `cashSalesTotal` = Σ SALE where `paymentMethod ∈ {CASH, CHEQUE, TRANSFER}`
- `creditSalesTotal` = Σ SALE where `paymentMethod == CREDIT`
- End-of-day "expected cash" must use **cashSalesTotal + collections − cash returns**,
  never `creditSalesTotal`. Update `GetDailyKpiUseCase`, `DailyKpi`, `EndOfDayViewModel`,
  and the Home/EOD UI to show cash vs credit separately.

### 5.4 AR aging on the van

Upgrade the existing `ReceivablesReportScreen`:
- show **buckets** (Current / 1–30 / 31–60 / 61–90 / 90+) with the **due/invoice toggle**,
  fed by `/ar/aging` when online, computed locally from invoices+payments when offline.
- keep the per-customer `AccountStatementScreen` (already exists) as the drill-in.

### 5.5 Returns free up credit

A RETURN whose **referenced original sale was a credit voucher** must **decrement** the
customer's AR balance (restore available credit), mirroring an ERP credit note. In
`CreateReturnVoucherUseCase` / balance adjust: if `referenceInvoice.paymentMethod == CREDIT`
→ `adjustBalance(customerId, −returnTotal)`. A return against a **cash** sale does **not**
touch AR. On the ERP side the credit note already reverses the receivable (§1); ensure the
dashboard export links the return to the original credit invoice so ERP applies it.

---

## 6. Enforcement rule (one definition, used everywhere)

```
available          = creditLimit − balance            (balance = open AR, ≥ 0)
blockCreditSale    = creditHold OR creditLimit <= 0 OR (balance + saleTotal) > creditLimit
                     (van uses offline-effective balance from §5.1)
onBlock            = hard reject; NO device override.
                     remedy = manager raises creditLimit → syncs → rep re-creates voucher
cashSaleUnaffected = CASH/CHEQUE/TRANSFER sales never blocked, never touch AR
creditReturn       = RETURN inherits the original sale's payment type; a credit return
                     → balance −= returnTotal (frees credit); a cash return doesn't touch AR
```

**Van-side refinements (field-requested, implemented):**
- **No limit ⇒ no credit.** On the van, `creditLimit <= 0` **blocks** the credit sale with
  a "customer has no credit limit" dialog (`NoCreditLimitException`) — a customer must have
  a positive limit to buy on credit. *(The ERP/dashboard still treat `creditLimit = 0` as
  "not enforced" for defense-in-depth; harmless because the van is the sale origin and
  blocks first. Align the backend to also block-on-0 only if you want a hard server gate.)*
- **Return inherits the sale's payment type** — the van copies the original sale's payment
  method onto the RETURN (credit→credit frees A/R, cash→cash), from the local saved sale or
  the server-looked-up sale (`VoucherDetailDto.payments`).
- **Offline numbering = last number + 1** — `VoucherNumberGenerator` uses the max trailing
  sequence + 1 (not COUNT+1), so a cancelled/removed voucher never causes a reused number.

Money: fils/thousandths integers end-to-end; ERP v1 API converts to/from major decimals
with `round(x*1000)`.

---

## 7. Phased plan & acceptance

**Phase 1 — ERP (source of truth)** — ✅ **DONE** (migration `0083_wise_blockbuster.sql`)
- [x] `customers.payment_terms_days`, `customers.credit_hold`, `invoices.due_date`
- [x] `checkCreditAvailable` (`src/lib/ar/credit-check.ts`) wired into `POST /api/v1/sales-invoices`
      (hard 409 `CREDIT_LIMIT_EXCEEDED`, no bypass); invoice now stamps `paymentType` + `due_date`
- [x] `GET /api/v1/customers/{id}/aging`, `…/by-code/{code}/aging`, `GET /api/v1/ar/aging`
      (`basis=due|invoice`, `asOf`; shared `src/lib/ar/aging.ts`)
- [x] `notifyVanflow("receipt")` on `POST /api/v1/receipts` (nudge re-pull on balance change)
- [ ] *Follow-up:* document the 4 new endpoints in `openapi.json/route.ts` (Scalar reference)
- [ ] *Follow-up:* run `npm run db:migrate` on each ERP deployment (migrations are not auto-run)
- ✅ *Accept:* over-limit CREDIT invoice returns 409 and does not post; raising the
  customer's `creditLimit` then resubmitting posts; aging endpoints return correct buckets
  for both bases; a credit note / receipt reduces the balance.

> **Note (unverified at runtime):** typecheck + lint + migration-generate all pass, but the
> endpoints have not been exercised against a live seeded DB. First Phase-2 integration
> should smoke-test: create a positive-limit customer, post a credit sale to the limit,
> confirm the next one 409s, then GET the aging endpoints.

**Phase 2 — Dashboard** — ✅ **DONE** (backend tsc+test green; frontend tsc+lint+build green)
- [x] `customers.credit_hold` column (migration `1721200000000-CustomerCreditHold.ts`);
      ERP-sync pulls `paymentTermsDays`/`creditHold` + mirrors ERP `/ar/aging` balance → `total_debt`
- [x] AR module (`src/modules/ar/`): `GET /v1/ar/aging`, `/v1/ar/arrears-summary`,
      `/v1/ar/customers/:number/{aging,balance}` (proxy ERP + local fallback)
- [x] Credit re-check in `VouchersService.create` (409 CREDIT_LIMIT_EXCEEDED / CREDIT_HOLD)
- [x] ERP exposes `paymentTermsDays`+`creditHold` on `/api/v1/customers` (serializer + selects)
- [x] FE: `/ar` aging page (bucket table + due/invoice toggle + CSV) + arrears widget on overview
- ✅ *Accept:* dashboard shows balances + aging from ERP; arrears widget shows monthly
  credit-sold vs collected + past-due list; over-limit credit voucher rejected on sync (409).

**Phase 3 — FlowVan** — ⚠️ **CORE DONE** (code reviewed; KMP build NOT run in this env)
- [x] **Hard block** over-limit credit sale in `CreateSaleVoucherUseCase`
      (`CreditLimitExceededException`, offline-safe via running local balance) + friendly
      "ask manager to raise the limit" message (`err_credit_limit`, ar+en)
- [x] `DailyKpi` cash/credit split (`cashSalesTotal`/`creditSalesTotal` +
      `InvoiceRepository.{cash,credit}SalesTotalSince`) + EOD screen shows both rows
- [x] RETURN of a credit sale decrements balance — **already existed**
      (`CreateReturnVoucherUseCase` + `CommitApprovedReturnUseCase`, gated on CREDIT)
- [ ] *Remaining:* `ArApi` live per-customer balance fetch on customer-open (+ stale badge);
      aging buckets + basis toggle on `ReceivablesReportScreen`; `creditHold` on the local
      Customer (needs a Room migration). Offline balance fallback already works (mirrored on
      catalog sync).
- ✅ *Accept:* offline over-limit credit sale is blocked with the "ask manager" message;
  after the manager raises the limit and it syncs, the re-created voucher passes; EOD shows
  cash vs credit separately; a credit return frees credit.

---

## 8. Decisions (resolved) & remaining open item

Resolved with the product owner:

1. **One payment type per voucher** — a sale is entirely CASH *or* CREDIT (matches the
   van's up-front payment chooser). A credit sale's **full total** consumes the limit.
   No mixed-payment split.
2. **No on-van override** — an over-limit credit sale is a **hard block**. The remedy is a
   **manager raising `customer.creditLimit`** (dashboard/ERP), which syncs down so the rep
   re-creates the voucher. No PIN, no role bypass, no override-audit table.
3. **Returns free credit** — a RETURN referencing a **credit** original sale decrements the
   balance; a return on a cash sale does not touch AR (§5.5).
4. **Arrears = past payment terms** — the dashboard widget flags customers whose open
   credit receivables are **past due** (`dueDate < asOf`, i.e. beyond their
   `payment_terms_days`). Not-yet-due balances are excluded (§4.2).

Remaining open (does not block Phase 1):

- **Dashboard `/v1/ar/*`: live proxy vs. cached mirror** — call ERP live each request
  (freshest, adds latency + ERP coupling) or serve the mirrored value refreshed on
  webhook/interval (fast, may lag). Leaning **cached mirror + webhook-nudged refresh**;
  confirm at Phase 2.
