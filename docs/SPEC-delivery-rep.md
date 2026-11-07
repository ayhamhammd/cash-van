# SPEC — Delivery & collection representative (backend, and the whole picture)

Status: **proposal**. This is the master spec. The other three refer to it as "BE §n":

| System | Spec |
|---|---|
| ERP | `ERP/docs/SPEC-delivery-rep-erp.md` |
| Dashboard | `cash-van-dashboard-frontend/docs/SPEC-delivery-rep-dashboard.md` |
| App (FlowVan) | `FlowVan/docs/SPEC-delivery-rep-app.md` |

The Arabic version follows the English one, in the same file (§A).

---

## 1. What we are building

A **delivery & collection representative** (مندوب توصيل وتحصيل) delivers invoices the ERP has already issued. On the phone he:

1. sees the invoices assigned to him (a "run"), each with its customer, recipient, address and lines;
2. checks every line on delivery. When something is missing, refused or damaged, he records the delivered quantity, the reason and a note;
3. takes a photo of the shipment and gets the customer's signature;
4. prints the invoice with its JoFotara QR, plus a delivery note when quantities differ;
5. collects payment (cash, cheque, transfer), as a salesman does today;
6. sees his delivered history and the customer's statement.

Anything that differs from the invoice becomes a **return request**. An admin approves it, and the ERP then issues a **return invoice (credit note)**, filed with JoFotara. All of this shows on the invoice in the app, the dashboard and the ERP.

### 1.1 The decision: one app, a role on the rep

We extend FlowVan rather than build a second app.
- **Already in FlowVan:** collections, statements, printing with QR on the same printers, offline sync, sign-in and device binding, live updates.
- **What a second app would mean:** copying all of that and doubling every client release (one build per client today).
- **The role lives on the rep:** **Sales**, **Delivery** or **Both**. The app shows a different home for a delivery rep and hides selling, van stock, trips and new shops.

### 1.2 Rules that hold across all three systems

| # | Rule | Why |
|---|---|---|
| R1 | **The ERP owns the delivery run.** The dashboard and the ERP's own Delivery page both write to it; CashVan keeps a read mirror for the phones. | The ERP already has runs (`delivery_runs`, migration 0126) and owns the invoices. Two owners of one assignment drift apart. |
| R2 | **A delivered invoice is never edited.** A shortage or refusal becomes a return request, then a credit note. | The invoice is issued, its stock is already deducted (ERP 0126 header), and it may be filed with JoFotara. |
| R3 | **The return is approved in one place: the ERP.** The dashboard approves *through* the ERP API. | The credit note is an ERP document, and one queue avoids the same return being approved twice. |
| R4 | **A return is customer credit, never a cut to the rep's cash.** | The existing rule (returns are credit). The rep hands in what he collected, not "invoice minus returns". |
| R5 | **A run moves no stock.** Only an approved return moves stock: GOOD lines back to the sale's warehouse, DAMAGED lines to the damaged warehouse. | This is the ERP's design (0126): the sale already deducted the stock. |
| R6 | **Delivery works offline.** The run is downloaded to the phone; results, photos and signatures queue and upload later. | Same as sales today. |
| R7 | **A delivery rep is an ERP salesman with the same code**, and still gets a store whose code is that code. | It keeps the "van code = salesman code = warehouse code" identity that receipt attribution depends on. Without it, receipts land on the wrong cash account (the known 110101 problem). The store holds no stock. |

---

## 2. Words used in all four specs

| Term | Meaning |
|---|---|
| **Run** (رحلة توصيل) | ERP `delivery_runs`: one rep, an optional vehicle, a date, a list of invoices. OPEN, then CLOSED. |
| **Stop** (محطة) | One invoice on a run (ERP `delivery_run_items`). |
| **Line result** | Per invoice line: invoiced qty, delivered qty, reason, note. |
| **Discrepancy** (فرق) | Delivered ≠ invoiced on at least one line. |
| **Return request** (طلب إرجاع) | The discrepancy waiting for approval. Approved → credit note. |
| **Proof** (إثبات تسليم) | The shipment photo(s), the signature image, the signer's name, GPS and time. |

**Stop statuses** (ERP is the source; the mirror copies them):

| Status | Meaning |
|---|---|
| `LOADED` | On the truck, not yet delivered. |
| `DELIVERED` | Everything delivered as invoiced. |
| `PARTIAL` | **New.** Delivered with at least one line short. |
| `RETURNED` | The customer refused the whole invoice. |

**Return status per stop:**

| Status | Meaning |
|---|---|
| `NONE` | No discrepancy. |
| `PENDING` | Waiting for approval. |
| `APPROVED` | A credit note was issued (its number and QR are stored on the stop). |
| `REJECTED` | Refused, with the admin's note. The invoice stands as issued, and the office follows up with the customer or the rep. |

**Discrepancy reasons:** a fixed list, labelled in Arabic and English. Each reason sets the condition of the goods, which decides where the stock goes back.

| Code | ar | en | Condition |
|---|---|---|---|
| `NOT_LOADED` | لم تُحمَّل | Not loaded | GOOD (the goods never left the warehouse) |
| `CUSTOMER_REFUSED` | رفض الزبون | Customer refused | GOOD |
| `DAMAGED` | تالف | Damaged | DAMAGED |
| `EXPIRED` | منتهي الصلاحية | Expired | DAMAGED |
| `WRONG_ITEM` | صنف خاطئ | Wrong item | GOOD |
| `LOST` | مفقود | Lost in delivery | DAMAGED, so it is written off from the damaged warehouse (Q4) |
| `OTHER` | أخرى | Other (note required) | GOOD; the approver can change it |

The approver may change any line's quantity and condition before approving.

---

## 3. End-to-end flow

```
OFFICE (dashboard or ERP)         ERP                         CASHVAN BACKEND              PHONE (delivery rep)
──────────────────────────        ───                         ───────────────              ────────────────────
1. Create run: rep, vehicle,  ──▶ delivery_runs + items  ──▶  pull (cursor) → mirror  ──▶ sync.required{deliveries}
   date, invoices                 (loading picks as today)    delivery_* tables              → downloads run, lines, QR
                                                                                          2. Opens stop, checks lines,
                                                                                             photo + signature, prints
                                                                                          3. Saves (offline OK)
                                  ◀── outbox DELIVERY_PROOF ◀─ POST sync/delivery-proofs ◀─ photo/signature files
                                  ◀── outbox DELIVERY_RESULT◀─ POST sync/deliveries      ◀─ result (clientRef)
                                  stop → DELIVERED/PARTIAL/RETURNED;
                                  line results stored; return_status=PENDING when there is a difference
4. Approve / edit / reject    ──▶ credit note (+ stock + journal + JoFotara)
   (dashboard → ERP API,          stop.return_status=APPROVED, credit_note_id
    or the ERP page)          ──▶ pull → mirror           ──▶ sync.required{deliveries} → app shows status, prints credit note
5. Collection on delivery:        receipts (existing)    ◀── outbox PAYMENT (existing) ◀── POST sync/collections (existing)
```

### 3.1 Collecting on delivery
- **Opening a stop:** the app offers to collect, prefilled with the invoice's remaining amount minus the value of any pending discrepancy.
- **Allocation:** the collection carries the **ERP invoice number** (§6.4), so the ERP allocates the receipt to that invoice rather than FIFO.
- **If the return is later rejected:** the invoice remains partly unpaid, and the statement shows it. The rep's cash is never adjusted (R4).

### 3.2 Increases (the customer takes more than invoiced)
Not allowed on the delivered invoice (R2). With the company setting `deliveryIncreaseRequests` on:
- the app may record an **increase request** (item and quantity);
- it goes to the office as a pending request;
- the office raises a new invoice for it, usually on the next run.

Default: **off**. Selling from surplus on the truck is out of scope; it would turn the vehicle into a stock-holding warehouse (Q1).

---

## 4. Data — backend

### 4.1 Migration `…-DeliveryRep`

**`reps.kind`**
- `text NOT NULL DEFAULT 'SALES'`, with CHECK `IN ('SALES','DELIVERY','BOTH')`.
- Existing reps stay SALES, so nothing changes until an admin picks a role.

**Mirror tables.** The ERP is the source. CashVan writes them only from the ERP pull, and from its own pending results (`local_*` columns).

```
delivery_runs
  id uuid pk, erp_id text unique, run_number text, rep_id uuid → reps (null when the
  driver's code matches no rep), driver_code text, vehicle_name text, run_date date,
  status text (OPEN|CLOSED), notes text, erp_updated_at timestamptz, synced_at timestamptz

delivery_stops
  id uuid pk, erp_id text unique, run_id → delivery_runs ON DELETE CASCADE,
  sequence int, erp_invoice_id text, invoice_number text, customer_id uuid → customers,
  erp_customer_id text, recipient_name text, recipient_phone text, address text,
  total_fils bigint, tax_fils bigint, paid_fils bigint, payment_type text,
  jofotara_status text, jofotara_qr text, jofotara_uuid text,
  status text (LOADED|DELIVERED|PARTIAL|RETURNED),
  delivered_at timestamptz, signed_by_name text, lat numeric, lng numeric,
  return_status text (NONE|PENDING|APPROVED|REJECTED), return_decision_note text,
  credit_note_number text, credit_note_qr text, credit_note_total_fils bigint,
  local_result_ref text   -- the clientRef of the phone's result, while it is in flight

delivery_stop_lines
  id uuid pk, stop_id → delivery_stops ON DELETE CASCADE, erp_invoice_item_id text,
  line_no int, sku_code text, name_ar text, name_en text, unit text,
  invoiced_qty numeric, unit_price_fils bigint, tax_rate numeric,
  delivered_qty numeric null, reason_code text null, note text null, condition text null,
  approved_qty numeric null          -- the quantity the approver accepted as returned

delivery_proofs
  id uuid pk, client_ref text unique, stop_id → delivery_stops, kind text (PHOTO|SIGNATURE),
  storage_key text, mime text, size_bytes int, captured_at timestamptz,
  erp_attachment_id text null, uploaded_by uuid → users, created_at
```

**`voucher_inbox.type`** gains `DELIVERY`. A delivery result goes through the same staging, retry and dead-letter path as vouchers and collections (`sync-inbox-drain.service.ts`).

**`collections.erp_invoice_number`**
- `text NULL`: the ERP invoice a collection was taken against.
- When set, the PAYMENT push sends it as `invoiceNumber` (`buildPayment`, `erp-outbox.service.ts:1146`).

**Company settings** (all served in `company-info`)
- `app_settings.delivery_increase_requests boolean DEFAULT false`.
- `app_settings.delivery_proof_required boolean DEFAULT true`.
- `company-info` also returns `hasDeliveryReps`: true when any active rep is DELIVERY or BOTH. The dashboard uses it to show the Deliveries menu.

### 4.2 Storage
- Proof files use `StorageService` (local disk today) under `deliveries/<stopId>/<clientRef>.<ext>`.
- Limits:
  - photo: JPEG, at most 3 MB after the phone's resize, at most 5 per stop;
  - signature: PNG, at most 200 KB.

---

## 5. Reading from the ERP (the mirror)

- **Pull:** `pullDeliveryRuns()` in `erp-sync.service.ts` reads `GET /api/v1/delivery-runs?updatedSince=<cursor>` (ERP §4). It runs every 2 minutes and right after every dashboard write.
  - It upserts runs, stops and lines.
  - It resolves `driver_code` → `reps.code`, and `erp_customer_id` → `customers`.
- **Signals:** a change to a stop's status, return status or credit note, or a stop added to or removed from a run, emits `delivery.changed {repId, runId}`. The event bridge turns that into:
  - `sync.required {resource:"deliveries"}` to that rep (new resource in `realtime/sync-signal.ts`);
  - `delivery.updated` to dashboard watchers.
- **A stop removed from a run** in the ERP is deleted from the mirror, unless a result for it is still in flight (`local_result_ref`). In that case it is kept until the ERP answers, so a delivery that really happened is not lost.
- **A run moved to another rep:** the old rep's phone drops it on the next refresh. Its unsent result still uploads: intake does not check ownership, the same as for sales.

---

## 6. API — backend

### 6.1 Phone (delivery rep, `repKind` DELIVERY or BOTH)

| Method | Path | What it does |
|---|---|---|
| GET | `/deliveries/mine` | Open runs for this rep, plus stops delivered in the last 2 days. Each stop includes its lines, QR, return status and credit note. One call fills the phone. |
| GET | `/deliveries/history?from&to&status&customerId&page` | Delivered history, paged. Same row shape. |
| GET | `/deliveries/stops/:id` | One stop, fresh from the mirror. |
| POST | `/sync/delivery-proofs` | Multipart: `file`, `clientRef`, `stopId`, `kind`, `capturedAt`. Idempotent on `clientRef`. Returns `{proofId}`. |
| POST | `/sync/deliveries` | The result (body below). Returns **202** with the verdict in the body, like `sync/vouchers`. |
| GET | `/sync/status?clientRefs=` | Existing; covers DELIVERY rows too. |

**Result body**
```json
{
  "clientRef": "d-7f3…",            // minted once on the phone
  "stopId": "…",
  "outcome": "DELIVERED|PARTIAL|RETURNED",
  "deliveredAt": "2026-11-08T10:42:00+03:00",
  "signedByName": "أبو محمد",
  "lat": 31.95, "lng": 35.91,
  "proofRefs": ["p-1…", "s-1…"],    // proofs already uploaded
  "lines": [ { "erpInvoiceItemId": "…", "deliveredQty": 8, "reasonCode": "DAMAGED", "note": "كرتونة مبلولة" } ],
  "increase": [ { "skuCode": "…", "qty": 2 } ],   // only when deliveryIncreaseRequests is on
  "note": "…"
}
```

**Validation**
- Each line: `0 ≤ deliveredQty ≤ invoicedQty`.
- When the two differ, a reason is required; `OTHER` also needs a note.
- `outcome` must agree with the lines: all full → DELIVERED; all zero → RETURNED; otherwise PARTIAL.
- At least 1 photo and 1 signature, unless the company turns proofs off (`deliveryProofRequired`, default on). A RETURNED stop needs a photo only.
- A stop that is already final, with a different clientRef, gets **409 STOP_ALREADY_FINAL**. The phone shows it and drops its copy.

**Intake**
1. Store the row in `voucher_inbox` (type DELIVERY).
2. Write `local_result_ref` and the line results into the mirror right away, so the dashboard shows "delivered — sending to ERP".
3. Enqueue the outbox rows: `DELIVERY_PROOF` (one per proof), then `DELIVERY_RESULT`.
4. Return the verdict: `accepted`.

The ERP's answer later sets the final status.

### 6.2 Dashboard

| Method | Path | Permission |
|---|---|---|
| GET | `/deliveries/runs?date&repId&status` | `deliveries.view` |
| GET | `/deliveries/runs/:id` | `deliveries.view` |
| POST | `/deliveries/runs` (repId, vehicleErpId?, runDate, invoiceNumbers[], notes) | `deliveries.manage` |
| PATCH | `/deliveries/runs/:id` (add/remove invoices, reorder, change rep or vehicle) | `deliveries.manage` |
| POST | `/deliveries/runs/:id/close` | `deliveries.manage` |
| GET | `/deliveries/loadable-invoices?from&to&customerId&locationId&salesmanCode&q` | `deliveries.manage` |
| GET | `/deliveries/vehicles` | `deliveries.view` |
| GET | `/deliveries/returns?status=PENDING` | `deliveries.view` |
| POST | `/deliveries/returns/:stopId/approve` (lines: [{erpInvoiceItemId, qty, condition}], note) | `deliveries.approveReturn` |
| POST | `/deliveries/returns/:stopId/reject` (note) | `deliveries.approveReturn` |
| GET | `/deliveries/stops/:id/proofs/:proofId` | `deliveries.view` (streams the file) |
| GET | `/deliveries/stops/by-invoice/:invoiceNumber` | `deliveries.view` (the invoice's Delivery panel) |

**How the dashboard's writes reach the ERP**
- They call the ERP **live**: the office is online, and an answer such as "invoice is on another run" must come back at once. There is no outbox for these.
- After the ERP answers, the backend pulls that run straight away so the mirror is current.
- If the ERP is down, the dashboard shows **503 ERP_UNAVAILABLE**.

**Loadable invoices**
- This proxies ERP `GET /sales-invoices` (status issued or partially_paid), minus invoices on an open run.
- `locationId` narrows it to customers in that subtree of the location tree.

**Approve and reject**
- Approving calls ERP §4.6 with `approvedBy` = the dashboard user's name and id. The ERP records it as text, as `credit_limit_overrides` already does.

### 6.3 `auth/me` and login
- New fields: `rep.kind` → `repKind: "SALES"|"DELIVERY"|"BOTH"`, plus `permissions.canDeliver` (true for DELIVERY and BOTH).
- `users.user_type` stays `SALES` for every rep. `DRIVER` exists but is unused, and it can't say "both".
- The dashboard's RBAC already keeps SALES out of the dashboard. That is unchanged.

### 6.4 Collections
- `POST /sync/collections` gains an optional `erpInvoiceNumber`. It is stored on the collection and sent to the ERP as `invoiceNumber`.
- Methods stay cash, cheque and transfer. Card for collections is a separate decision (Q6).

### 6.5 Outbox (new kinds in `erp-outbox.entity.ts`)

| Kind | ERP call | Order |
|---|---|---|
| `DELIVERY_PROOF` | `POST /api/v1/attachments` (multipart, `entityType=DELIVERY_RUN_ITEM`, `entityId`, `role=PHOTO\|SIGNATURE`, idempotency key = proof clientRef) | before the result |
| `DELIVERY_RESULT` | `POST /api/v1/delivery-runs/items/{erpItemId}/result` (idempotency key = result clientRef) | waits until every proof in `proofRefs` is posted |

- A 409 from the ERP because the stop is already final is **terminal**. The admin sees it in the Sync inbox.
- Network errors and 5xx retry, as today.

### 6.6 Notifications
- **Result with a discrepancy:** `notifyManagers` with "Return request: invoice X, customer Y, n lines, value Z".
- **Approve or reject:** `notifyUser` to the rep, plus `sync.required {deliveries}`.

### 6.7 Permissions (dotted keys)
- `deliveries.view`, `deliveries.manage`, `deliveries.approveReturn`, for dashboard users.
- The rep side is decided by `reps.kind`, not by keys. The existing app flags (`canMakeCollection`, `canPrintLineDiscount`, …) apply as usual.

---

## 7. Tests (backend)
- **Mirror pull:**
  - upsert;
  - driver code → rep;
  - a stop removed in the ERP is deleted, unless a result is in flight;
  - signals go to the right rep.
- **Intake:**
  - all validation rules;
  - outcome and lines must agree;
  - idempotent clientRef;
  - 409 on a final stop;
  - the proof upload is idempotent.
- **Outbox:**
  - the result waits for its proofs;
  - the payload shape;
  - a 409 is terminal.
- **Collections:** `erpInvoiceNumber` reaches the PAYMENT payload.
- **auth/me:** `repKind`, `canDeliver`.
- **Real-DB integration:** a result with one short line → mirror PARTIAL / PENDING; approval → APPROVED with a credit note number after the pull.

---

## 8. Phases

| Phase | Backend | ERP | Dashboard | App |
|---|---|---|---|---|
| **1 — Assign & deliver** | `reps.kind`, mirror, pull, `/deliveries/mine`, history, run endpoints, `erpInvoiceNumber` on collections | v1 runs API, driver = salesman, QR on invoice API | Role in the rep form; Deliveries pages (build run, follow it) | Delivery home, stop detail, print the invoice with QR, collect, history. Outcome is whole-invoice only (Delivered or Refused) |
| **2 — Proof & lines** | proofs, results, outbox kinds, intake | line results, PARTIAL, attachments API | proofs and line results shown | line check, reasons, photo, signature pad, delivery-note print |
| **3 — Returns** | returns endpoints, notifications | approve → credit note, return queue | Delivery returns queue, approve or edit or reject | return status, credit note print |
| **4 — Optional** | increase requests | — | increase requests queue | increase entry |

Each phase ships on its own and is safe on its own. A company with no delivery reps sees nothing new.

---

## 9. Open questions (defaults in **bold**)

| # | Question | Default |
|---|---|---|
| Q1 | May a delivery rep sell extra from the truck? | **No.** An increase is a request the office invoices (§3.2). |
| Q2 | The ERP refuses to load a fully **paid** invoice (`ALREADY_PAID`). A prepaid invoice still needs delivering. | **Allow it** for runs; keep the warning. |
| Q3 | Where are returns approved? | **ERP owns it**; the dashboard approves through it (R3). |
| Q4 | Lost goods: credit the customer, and treat the stock how? | **As damaged:** to the damaged warehouse, written off from there. |
| Q5 | Must a CASH invoice be collected before it can be marked delivered? | **No.** The app reminds; it doesn't block. |
| Q6 | Card (Visa) as a collection method? | **Not in this work.** Visa lands in the bank: a separate decision. |
| Q7 | How many photos, and are proofs mandatory? | **1–5 photos plus a signature, mandatory.** Company switch to relax. |
| Q8 | Can one run have two reps (driver + helper)? | **No.** One rep per run. |

---
---

# §A — النسخة العربية

## مواصفات — مندوب التوصيل والتحصيل (الخادم، والصورة الكاملة)

الحالة: **مقترح**. هذا هو الملف الرئيسي، وتشير إليه الملفات الثلاثة الأخرى بـ "BE §n":

| النظام | الملف |
|---|---|
| الـERP | `ERP/docs/SPEC-delivery-rep-erp.md` |
| لوحة التحكم | `cash-van-dashboard-frontend/docs/SPEC-delivery-rep-dashboard.md` |
| التطبيق (FlowVan) | `FlowVan/docs/SPEC-delivery-rep-app.md` |

### 1. ماذا سنبني

**مندوب التوصيل والتحصيل** يوصل فواتير أصدرها الـERP مسبقاً. على الهاتف:

1. يرى الفواتير المسندة إليه ("رحلة توصيل")، ومع كل فاتورة الزبون والمستلم والعنوان والأصناف؛
2. يتحقق من كل صنف عند التسليم. إذا نقص صنف أو رُفض أو كان تالفاً، يسجّل الكمية المسلّمة والسبب وملاحظة؛
3. يصوّر الشحنة ويأخذ توقيع الزبون؛
4. يطبع الفاتورة مع رمز QR الخاص بالفوترة الوطنية (JoFotara)، ومعها سند تسليم إذا اختلفت الكميات؛
5. يحصّل الدفعات (نقداً، شيكات، حوالة) كما يفعل مندوب المبيعات اليوم؛
6. يرى سجل الفواتير التي سلّمها وكشف حساب الزبون.

أي فرق عن الفاتورة يصبح **طلب إرجاع**. يعتمده المسؤول، ثم يصدر الـERP **فاتورة مرتجع (إشعار دائن)** وتُرفع إلى الفوترة الوطنية. ويظهر كل ذلك على الفاتورة في التطبيق ولوحة التحكم والـERP.

#### 1.1 القرار: تطبيق واحد، ودور على المندوب

نوسّع تطبيق FlowVan الحالي بدل بناء تطبيق ثانٍ.
- **موجود اليوم في FlowVan:** التحصيل، كشوف الحساب، الطباعة مع QR على نفس الطابعات، العمل دون اتصال، تسجيل الدخول وربط الجهاز، التحديث اللحظي.
- **ما يعنيه تطبيق ثانٍ:** نسخ كل ذلك ومضاعفة كل إصدار لكل عميل (لكل عميل نسخة مستقلة اليوم).
- **الدور على سجل المندوب:** **مبيعات** أو **توصيل** أو **الاثنان**. يعرض التطبيق لمندوب التوصيل شاشة رئيسية مختلفة، ويخفي البيع ومخزون السيارة والرحلات وإضافة الزبائن.

#### 1.2 قواعد ثابتة في الأنظمة الثلاثة

| # | القاعدة | السبب |
|---|---|---|
| R1 | **الـERP هو مالك رحلة التوصيل.** لوحة التحكم وصفحة التوصيل في الـERP تكتبان فيها، ويحتفظ CashVan بنسخة للقراءة من أجل الهواتف. | الرحلات موجودة في الـERP (`delivery_runs`، ترحيل 0126) وهو مالك الفواتير. مالكان لنفس الإسناد يتباعدان مع الوقت. |
| R2 | **الفاتورة المسلّمة لا تُعدَّل أبداً.** النقص أو الرفض يصبح طلب إرجاع، ثم إشعاراً دائناً. | الفاتورة صادرة، وخُصم مخزونها مسبقاً، وقد تكون مرفوعة للفوترة الوطنية. |
| R3 | **اعتماد المرتجع في مكان واحد: الـERP.** لوحة التحكم تعتمد *عبر* واجهة الـERP. | الإشعار الدائن مستند في الـERP، وقائمة واحدة تمنع اعتماد نفس المرتجع مرتين. |
| R4 | **المرتجع رصيد للزبون، ولا ينقص نقدية المندوب أبداً.** | القاعدة المعمول بها (المرتجع رصيد). المندوب يسلّم ما حصّله فعلاً، لا "الفاتورة ناقص المرتجع". |
| R5 | **الرحلة لا تحرّك مخزوناً.** فقط المرتجع المعتمد يحرّكه: السليم يعود لمستودع البيع، والتالف لمستودع التالف. | هذا تصميم الـERP (0126): البيع خصم المخزون مسبقاً. |
| R6 | **التوصيل يعمل دون اتصال.** تُنزَّل الرحلة إلى الهاتف، والنتائج والصور والتواقيع تنتظر في قائمة الرفع. | كالمبيعات اليوم. |
| R7 | **مندوب التوصيل مندوب في الـERP بنفس الرمز**، ويبقى له مستودع رمزه هو نفس الرمز. | يحافظ على قاعدة "رمز السيارة = رمز المندوب = رمز المستودع" التي يعتمد عليها نسب سندات القبض. بدونها تقع السندات على حساب نقدية خاطئ (مشكلة 110101 المعروفة). المستودع لا يحمل مخزوناً. |

### 2. المصطلحات في الملفات الأربعة

| المصطلح | المعنى |
|---|---|
| **رحلة توصيل** (Run) | `delivery_runs` في الـERP: مندوب واحد، سيارة (اختيارية)، تاريخ، قائمة فواتير. مفتوحة ثم مغلقة. |
| **محطة** (Stop) | فاتورة واحدة على الرحلة (`delivery_run_items`). |
| **نتيجة السطر** | لكل صنف في الفاتورة: الكمية المفوترة، الكمية المسلّمة، السبب، ملاحظة. |
| **فرق** | الكمية المسلّمة ≠ المفوترة في سطر واحد على الأقل. |
| **طلب إرجاع** | الفرق بانتظار الاعتماد. عند الاعتماد → إشعار دائن. |
| **إثبات التسليم** | صورة الشحنة (أو صور)، صورة التوقيع، اسم الموقّع، الموقع الجغرافي والوقت. |

**حالات المحطة** (المصدر هو الـERP، والنسخة عندنا تنقلها):

| الحالة | المعنى |
|---|---|
| `LOADED` | محمّلة على السيارة، ولم تُسلَّم بعد. |
| `DELIVERED` | سُلّم كل شيء كما في الفاتورة. |
| `PARTIAL` | **جديدة.** سُلّمت مع نقص في سطر واحد على الأقل. |
| `RETURNED` | رفض الزبون الفاتورة كاملة. |

**حالة الإرجاع لكل محطة:**

| الحالة | المعنى |
|---|---|
| `NONE` | لا يوجد فرق. |
| `PENDING` | بانتظار الاعتماد. |
| `APPROVED` | صدر إشعار دائن (رقمه ورمز QR الخاص به محفوظان على المحطة). |
| `REJECTED` | مرفوض، مع ملاحظة المسؤول. تبقى الفاتورة كما صدرت، ويتابع المكتب مع الزبون أو المندوب. |

**أسباب الفرق:** قائمة ثابتة بالعربية والإنجليزية. كل سبب يحدّد حالة البضاعة، وهي التي تحدّد أين يعود المخزون.

| الرمز | عربي | إنجليزي | الحالة |
|---|---|---|---|
| `NOT_LOADED` | لم تُحمَّل | Not loaded | سليم (البضاعة لم تغادر المستودع) |
| `CUSTOMER_REFUSED` | رفض الزبون | Customer refused | سليم |
| `DAMAGED` | تالف | Damaged | تالف |
| `EXPIRED` | منتهي الصلاحية | Expired | تالف |
| `WRONG_ITEM` | صنف خاطئ | Wrong item | سليم |
| `LOST` | مفقود | Lost in delivery | تالف، فيُشطب من مستودع التالف (Q4) |
| `OTHER` | أخرى | Other (الملاحظة إلزامية) | سليم؛ ويمكن للمعتمد تغييره |

يستطيع المعتمد تعديل كمية وحالة أي سطر قبل الاعتماد.

### 3. المسار من البداية للنهاية

1. **المكتب** (من لوحة التحكم أو الـERP) ينشئ رحلة: المندوب، السيارة، التاريخ، الفواتير.
   - الـERP يحفظها، ويبقى التحميل وتأشير الأصناف كما هو اليوم.
   - خادم CashVan يسحبها إلى نسخته المحلية، ويرسل إلى هاتف المندوب `sync.required{deliveries}`.
   - الهاتف ينزّل الرحلة بأصنافها ورموز QR.
2. **المندوب** يفتح المحطة، يتحقق من الأصناف، يصوّر ويأخذ التوقيع، يطبع، ثم يحفظ (حتى دون اتصال).
3. **الرفع:** الصور والتواقيع تُرفع إلى `sync/delivery-proofs`، والنتيجة إلى `sync/deliveries`. يمرّرها الخادم إلى الـERP عبر قائمة الإرسال: أولاً `DELIVERY_PROOF` ثم `DELIVERY_RESULT`.
   - يضع الـERP حالة المحطة: سُلّمت أو جزئي أو مرتجعة.
   - يحفظ نتائج الأسطر.
   - إذا وُجد فرق، تصبح حالة الإرجاع "بانتظار الاعتماد".
4. **الاعتماد:** المسؤول يعتمد (ويمكنه التعديل) أو يرفض، من لوحة التحكم (عبر واجهة الـERP) أو من صفحة الـERP.
   - يُنشأ الإشعار الدائن مع حركة المخزون والقيد ورفعه للفوترة الوطنية.
   - تُسحب النتيجة إلى النسخة المحلية، فيرى التطبيق الحالة ويستطيع طباعة الإشعار الدائن.
5. **التحصيل عند التسليم** يمرّ بالمسار الحالي نفسه: `sync/collections`، ثم قائمة الإرسال `PAYMENT`، ثم سندات القبض في الـERP.

#### 3.1 التحصيل عند التسليم
- **عند فتح المحطة:** يعرض التطبيق التحصيل، والمبلغ المقترح هو المتبقي من الفاتورة ناقص قيمة أي فرق ينتظر الاعتماد.
- **التخصيص:** يحمل سند التحصيل **رقم فاتورة الـERP** (§6.4)، فيخصّص الـERP المبلغ لتلك الفاتورة بدل التوزيع على الأقدم.
- **إذا رُفض المرتجع لاحقاً:** يبقى جزء من الفاتورة غير مدفوع، ويظهر في كشف الحساب. نقدية المندوب لا تُعدَّل أبداً (R4).

#### 3.2 الزيادة (الزبون يأخذ أكثر من الفاتورة)
غير مسموحة على الفاتورة المسلّمة (R2). إذا فعّلت الشركة إعداد `deliveryIncreaseRequests`:
- يستطيع التطبيق تسجيل **طلب زيادة** (الصنف والكمية)؛
- يصل الطلب إلى المكتب كطلب معلّق؛
- يصدر المكتب له فاتورة جديدة، غالباً على الرحلة التالية.

الافتراضي: **معطّل**. البيع من فائض السيارة خارج هذا العمل، لأنه يحوّل السيارة إلى مستودع يحمل مخزوناً (Q1).

### 4. البيانات — الخادم

#### 4.1 الترحيل `…-DeliveryRep`
- **`reps.kind`:** `SALES` أو `DELIVERY` أو `BOTH`، والافتراضي `SALES`. المندوبون الحاليون يبقون مندوبي مبيعات، فلا شيء يتغيّر حتى يختار المسؤول دوراً.
- **جداول النسخة المحلية** (المصدر هو الـERP، ولا يكتب فيها CashVan إلا من السحب ومن نتائجه المعلّقة):
  - `delivery_runs`: رقم الرحلة، المندوب، السيارة، التاريخ، الحالة.
  - `delivery_stops`:
    - الفاتورة والزبون والمستلم والعنوان؛
    - المبالغ ورمز QR؛
    - حالة التسليم والموقّع والموقع؛
    - حالة الإرجاع، ورقم الإشعار الدائن ورمز QR الخاص به.
  - `delivery_stop_lines`: الصنف، الكمية المفوترة، المسلّمة، السبب، الملاحظة، الحالة، الكمية المعتمدة كمرتجع.
  - `delivery_proofs`: الصورة أو التوقيع، مكان التخزين، ورقم المرفق في الـERP بعد رفعه.
- **`voucher_inbox.type`** يضاف إليه `DELIVERY`. نتيجة التوصيل تمرّ بنفس مسار الاستلام وإعادة المحاولة كالسندات والتحصيلات.
- **`collections.erp_invoice_number`:** رقم فاتورة الـERP التي حُصّل عليها. يُرسل للـERP كـ `invoiceNumber`.
- **إعدادات الشركة:**
  - `delivery_increase_requests` (الافتراضي معطّل)؛
  - `delivery_proof_required` (الافتراضي مفعّل)؛
  - `hasDeliveryReps` في `company-info`، لإظهار قائمة التوصيل في لوحة التحكم.

#### 4.2 التخزين
- ملفات الإثبات في `deliveries/<stopId>/`.
- الصورة: JPEG، حتى 3 ميغابايت، وحتى 5 صور لكل محطة.
- التوقيع: PNG، حتى 200 كيلوبايت.

### 5. القراءة من الـERP
- **السحب:** `pullDeliveryRuns()` يقرأ الرحلات المعدّلة من الـERP كل دقيقتين، وفوراً بعد أي تعديل من لوحة التحكم.
  - يربط رمز السائق بالمندوب عن طريق `reps.code`.
- **الإشعارات:** أي تغيير على محطة يرسل `sync.required{deliveries}` لهاتف ذلك المندوب، و`delivery.updated` للوحة التحكم.
- **محطة حُذفت من الرحلة** في الـERP تُحذف من النسخة، إلا إذا كانت لها نتيجة في الطريق. عندها تبقى حتى يرد الـERP، فلا يضيع تسليم حدث فعلاً.
- **رحلة نُقلت لمندوب آخر:** تختفي من هاتف المندوب القديم في التحديث التالي. نتيجته غير المرسلة تُرفع رغم ذلك، كما في المبيعات.

### 6. الواجهات البرمجية — الخادم

#### 6.1 للهاتف
- `GET /deliveries/mine`: الرحلات المفتوحة مع محطات آخر يومين، بأسطرها ورموز QR وحالة الإرجاع.
- `GET /deliveries/history`: سجل التسليم، مع فلترة بالتاريخ والحالة والزبون.
- `POST /sync/delivery-proofs`: رفع صورة أو توقيع. لا يتكرر بفضل `clientRef`.
- `POST /sync/deliveries`: رفع النتيجة. يرد 202 والحكم في الجسم.
- **قواعد التحقق:**
  - الكمية المسلّمة بين 0 والكمية المفوترة؛
  - عند الفرق، السبب إلزامي، و"أخرى" تحتاج ملاحظة؛
  - النتيجة يجب أن توافق الأسطر؛
  - صورة واحدة على الأقل وتوقيع (إلا إذا عطّلت الشركة ذلك). الفاتورة المرفوضة كاملة تحتاج صورة فقط؛
  - محطة نهائية مع `clientRef` مختلف → خطأ 409.

#### 6.2 للوحة التحكم
- إنشاء الرحلات وتعديلها وإغلاقها.
- البحث عن الفواتير القابلة للتحميل، مع فلترة بالمنطقة من شجرة المواقع.
- قائمة طلبات الإرجاع، واعتمادها مع إمكانية التعديل، أو رفضها.
- عرض صور الإثبات.
- كل ذلك يُنفَّذ **مباشرة** على الـERP. إذا كان الـERP متوقفاً تظهر رسالة "الـERP غير متاح".

#### 6.3 تسجيل الدخول `auth/me`
- حقلان جديدان: `repKind`، و`permissions.canDeliver`.
- `users.user_type` يبقى `SALES` لكل المندوبين.

#### 6.4 التحصيل
- `POST /sync/collections` يقبل `erpInvoiceNumber` اختيارياً.
- الطرق تبقى: نقداً، شيك، حوالة. البطاقة قرار منفصل (Q6).

#### 6.5 قائمة الإرسال للـERP
- `DELIVERY_PROOF`: رفع المرفق، قبل النتيجة.
- `DELIVERY_RESULT`: رفع النتيجة، بعد رفع كل صورها.
- رد 409 (المحطة نهائية) خطأ نهائي يظهر في صندوق المزامنة للمسؤول.

#### 6.6 التنبيهات
- **نتيجة فيها فرق:** تنبيه للمدراء.
- **اعتماد أو رفض:** تنبيه للمندوب، وتحديث لهاتفه.

#### 6.7 الصلاحيات
- لمستخدمي لوحة التحكم: `deliveries.view`، `deliveries.manage`، `deliveries.approveReturn`.
- دور المندوب نفسه يحدّده `reps.kind`.

### 7. الاختبارات
- **السحب:** ربط المندوب، والحذف من الرحلة.
- **الاستلام:** كل قواعد التحقق، وعدم التكرار، وخطأ 409.
- **قائمة الإرسال:** الترتيب، وشكل الطلب، وأن 409 نهائي.
- **التحصيل:** رقم الفاتورة يصل إلى الـERP.
- **تكامل على قاعدة بيانات حقيقية:** سطر ناقص → جزئي / بانتظار الاعتماد، ثم الاعتماد → إشعار دائن.

### 8. المراحل

| المرحلة | المحتوى |
|---|---|
| **1 — الإسناد والتوصيل** | الدور على المندوب، الرحلات في لوحة التحكم، الشاشة الرئيسية للتوصيل في التطبيق، طباعة الفاتورة مع QR، التحصيل، السجل. النتيجة على الفاتورة كاملة فقط (سُلّمت أو رُفضت). |
| **2 — الإثبات والأسطر** | التحقق سطراً سطراً، الأسباب، الصورة، التوقيع، سند التسليم. |
| **3 — المرتجعات** | قائمة الاعتماد، الإشعار الدائن، الحالة في التطبيق، طباعة الإشعار. |
| **4 — اختيارية** | طلبات الزيادة. |

كل مرحلة تُطلق وحدها وهي آمنة وحدها. والشركة التي ليس لديها مندوبو توصيل لا ترى أي تغيير.

### 9. أسئلة مفتوحة (الافتراضي بالخط العريض)

| # | السؤال | الافتراضي |
|---|---|---|
| Q1 | هل يبيع مندوب التوصيل من فائض السيارة؟ | **لا.** الزيادة طلب يفوتره المكتب. |
| Q2 | الـERP يرفض تحميل فاتورة **مدفوعة بالكامل**، والفاتورة المدفوعة مسبقاً تحتاج توصيلاً. | **السماح** للرحلات، مع إبقاء التحذير. |
| Q3 | أين يُعتمد المرتجع؟ | **في الـERP**، ولوحة التحكم تعتمد عبره. |
| Q4 | البضاعة المفقودة: كيف تُعامل؟ | **كتالف:** إلى مستودع التالف ثم تُشطب. |
| Q5 | هل يجب تحصيل الفاتورة النقدية قبل تسجيل التسليم؟ | **لا.** تذكير فقط، دون منع. |
| Q6 | البطاقة (فيزا) كطريقة تحصيل؟ | **ليست ضمن هذا العمل**، لأن الفيزا تذهب للبنك. |
| Q7 | عدد الصور، وهل الإثبات إلزامي؟ | **1–5 صور وتوقيع، إلزامي**، مع خيار للشركة لتخفيفه. |
| Q8 | هل تكون للرحلة مندوبان (سائق ومساعد)؟ | **لا.** مندوب واحد لكل رحلة. |
