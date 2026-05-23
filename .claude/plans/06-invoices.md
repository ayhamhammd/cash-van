# Plan 06 — Sales Invoices & Approval

Spec ref: Part 3.6 (adapted for single-tenant deployment)
Depends on: [01 — Reps](./01-tenants-auth-reps.md), [03 — Customers](./03-customers.md), [04 — Products](./04-products-inventory.md)

> **No `tenant_id` / no RLS** (single-tenant). `UNIQUE (tenant_id, invoice_number)` → `UNIQUE (invoice_number)`.
> **Invoice numbering:** global Postgres sequence → `INV-{YYYY}-{NNNNNN}`.
> **Anomaly hook (plan 08) not built yet:** `confirm` goes straight to `confirmed` and emits `invoice.confirmed`. Approval endpoints (approve/reject/override) are live for manual use now; auto-routing to `pending_approval` arrives with the anomaly detector.
> **JoFotara hook (plan 11) not built yet:** `confirm` emits `invoice.confirmed` on the EventEmitter; plan 11 will subscribe and submit to ISTD. Plan 06 never calls ISTD.
> **InvoiceCalculator** is built here (fils-based port of `Jordan_Tax_JoFotara_NodeJS_Spec.md` §5) and reused by plan 11.
> Tables do NOT extend `BaseEntity` — explicit columns (no `version`).

## Goal

Spec-compliant `invoices` + `invoice_lines` + manager-approval audit trail. The existing `voucher_headers`/`voucher_transactions` cover similar ground but use a different model (vendor-or-customer, multi-trans-kind, GL posting). Plan:

- Keep `voucher_*` tables for the legacy bookkeeping/GL flow.
- Add **new `invoices` / `invoice_lines` / `invoice_approvals`** for the VanFlow sales flow.
- A sale produces both: an `invoices` row (rep-facing) and on confirm, a posted `voucher_header` (GL). Bridge via a nullable `invoice_id` FK on `voucher_headers` (added here).

> If consolidation is preferred later, the bridge column lets you migrate in one shot.

## Tables

### `invoices`
All money columns are INTEGER **fils** (minor units). JOD conversion only at JoFotara boundary.
```
id UUID PK, tenant_id UUID, rep_id UUID FK→reps, customer_id UUID FK→customers,
invoice_number TEXT, status TEXT DEFAULT 'draft',

-- Totals (fils, INTEGER)
subtotal INT,                       -- sum(line.subtotal) before any discount
total_line_discounts INT,           -- sum(line.discount)
invoice_discount_amount INT,        -- header-level discount, distributed proportionally
net_taxable INT,                    -- net of TAXABLE lines after all discounts
net_inclusive INT,                  -- net of INCLUSIVE lines after all discounts
net_exempt INT,                     -- net of EXEMPT lines after all discounts
tax_on_taxable INT,                 -- tax added on top
tax_extracted_from_inclusive INT,   -- tax extracted from inclusive nets
total_tax INT,                      -- = tax_on_taxable + tax_extracted_from_inclusive
grand_total INT,                    -- = netT + tax_on_taxable + netI + netE

-- JoFotara / ISTD fields (see plan 11)
invoice_type_code TEXT NOT NULL DEFAULT '011',   -- 011 general | 021 special | 381 credit note
payment_method_code TEXT NOT NULL DEFAULT '012', -- 012 cash | 022 receivable
jofotara_uuid UUID,                              -- generated at confirm time, sent to ISTD
jofotara_status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|SUBMITTED|VALIDATED|REJECTED|ERROR
jofotara_qr_code TEXT,
jofotara_registration_number TEXT,
jofotara_error_code TEXT,
jofotara_error_message TEXT,
jofotara_submitted_at TIMESTAMPTZ,

note TEXT, created_at TIMESTAMPTZ, confirmed_at TIMESTAMPTZ,
cancelled_at TIMESTAMPTZ, device_id TEXT,
UNIQUE (tenant_id, invoice_number)
```
status (internal workflow): `draft | confirmed | pending_approval | rejected | cancelled`
jofotara_status (ISTD lifecycle): `PENDING | SUBMITTED | VALIDATED | REJECTED | ERROR`
The two are independent — an invoice can be `status=confirmed` while `jofotara_status=PENDING` if the ISTD submit is queued.

### `invoice_lines`
All money in fils.
```
id BIGSERIAL PK, invoice_id UUID FK→invoices, product_id UUID FK→item_cart,
quantity NUMERIC(14,3) NOT NULL,            -- supports fractional qty
unit_price INT NOT NULL,                    -- fils
unit_of_measure TEXT NOT NULL DEFAULT 'PCE',-- snapshot from product
-- Tax classification snapshot (so historical lines don't drift if product changes)
tax_type TEXT NOT NULL,                     -- TAXABLE|INCLUSIVE|EXEMPT
tax_category TEXT NOT NULL,                 -- S|Z|E
tax_rate NUMERIC(5,4) NOT NULL,             -- 0.1600 etc
-- Calculation breakdown (fils, computed by TaxCalculator; persisted so the JoFotara payload is deterministic)
subtotal INT NOT NULL,                      -- qty * unit_price
line_discount_type TEXT DEFAULT 'PERCENTAGE',
line_discount_value NUMERIC(14,3) DEFAULT 0,
line_discount_amount INT NOT NULL DEFAULT 0,
net_after_line_discount INT NOT NULL,
taxable_base INT NOT NULL,                  -- 0 for EXEMPT; net for TAXABLE; (net - extracted) for INCLUSIVE
tax_amount INT NOT NULL,
line_total INT NOT NULL
```

### `invoice_approvals`
```
id BIGSERIAL PK, invoice_id UUID FK→invoices, action TEXT, actor_id UUID FK→users,
reason TEXT, acted_at TIMESTAMPTZ
```
action: `submitted | approved | rejected | override`

### Credit notes (partial / full returns)
Plan 11 owns the `credit_notes` table (JoFotara `invoiceTypeCode=381`). Plan 06 only adds two columns/links:
- `invoices.has_credit_notes BOOLEAN DEFAULT FALSE` — flipped when first credit note created
- A `returnable_qty` view computed from `invoice_lines.quantity - SUM(credit_note_lines.quantity)` so the UI can validate further returns

> Don't ship return logic in plan 06 — see plan 11 for the full credit-note model + ISTD reference.

## Checklist

### Migration
- [ ] `<ts>-AddInvoicesAndApprovals.ts`
- [ ] `CREATE TABLE invoices` with status check constraints on **both** `status` and `jofotara_status`
- [ ] Check on `invoice_type_code IN ('011','021','381')` and `payment_method_code IN ('012','022')`
- [ ] Add `has_credit_notes BOOLEAN DEFAULT FALSE`
- [ ] `CREATE TABLE invoice_lines` with check on `tax_type IN ('TAXABLE','INCLUSIVE','EXEMPT')` and `tax_category IN ('S','Z','E')`
- [ ] `CREATE TABLE invoice_approvals`
- [ ] Indexes:
  - [ ] `(tenant_id, rep_id, created_at DESC)`
  - [ ] `(tenant_id, status, created_at DESC)`
  - [ ] `(tenant_id, customer_id)`
  - [ ] `invoice_lines (invoice_id)`, `(product_id)`
  - [ ] `invoice_approvals (invoice_id, acted_at DESC)`
- [ ] `ALTER TABLE voucher_headers ADD COLUMN invoice_id UUID REFERENCES invoices(id)` — bridge to legacy GL
- [ ] Enable RLS on all three

### Invoice numbering
- [ ] Sequence per tenant: `INV-{tenant_slug}-{YYYY}-{NNNNNN}` via Postgres sequence + trigger OR app-side advisory lock
- [ ] Document choice in `src/modules/invoices/invoice-number.service.ts`

### Entities
- [ ] `src/modules/invoices/entities/invoice.entity.ts`
- [ ] `src/modules/invoices/entities/invoice-line.entity.ts`
- [ ] `src/modules/invoices/entities/invoice-approval.entity.ts`

### Module
- [ ] `src/modules/invoices/invoices.module.ts` + service + controller
- [ ] `InvoiceCalculator` service: pure functions for subtotal, discount, tax, total. **Implements the algorithm from `Jordan_Tax_JoFotara_NodeJS_Spec.md` §5** — handles TAXABLE/INCLUSIVE/EXEMPT, per-line + invoice-level discounts, proportional discount allocation, and per-line tax recalculation after invoice discount. All math in fils (INTEGER). Snapshots `tax_type/category/rate/unit_of_measure` from product into the line at create time.
- [ ] `InvoiceLifecycleService` — handles state transitions; emits events:
  - [ ] `invoice.created` (after draft create)
  - [ ] `invoice.confirmed`
  - [ ] `invoice.approved`
  - [ ] `invoice.rejected`
  - [ ] `invoice.anomaly_flagged` (after AI scoring — wired in plan 08)

### Anomaly hook
- [ ] On `status=confirmed` transition, call AI anomaly endpoint asynchronously (plan 08). If HIGH severity returned → flip status to `pending_approval` and write `invoice_approvals` row `submitted`.

### JoFotara hook
- [ ] On `status=confirmed` (and not blocked by anomaly), publish `invoice.confirmed` event. Plan 11's `JoFotaraSubmissionService` listens, builds the payload, submits to ISTD, and writes back `jofotara_status / qr_code / registration_number` (or `_error_*`). Plan 06 must NOT call ISTD directly — that boundary belongs to plan 11.

### DTOs
- [ ] `CreateInvoiceDto` — `{ customer_id, lines: [{product_id, quantity, unit_price?, discount_pct?}], note?, device_id? }`
- [ ] `UpdateInvoiceDto` — only allowed while status='draft'
- [ ] `ConfirmInvoiceDto` — empty body, transitions draft→confirmed
- [ ] `ApprovalActionDto` — `{ action: 'approve'|'reject'|'override', reason? }`
- [ ] `InvoiceFilterDto` — `?rep_id&customer_id&status&anomaly_severity&from&to`

### Endpoints
- [ ] `GET /api/v1/invoices` — filters + paging + sorts; includes computed anomaly fields
- [ ] `GET /api/v1/invoices/:id`
- [ ] `POST /api/v1/invoices` — create draft
- [ ] `PATCH /api/v1/invoices/:id` — edit draft
- [ ] `POST /api/v1/invoices/:id/confirm` — draft → confirmed (or pending_approval if anomaly HIGH)
- [ ] `POST /api/v1/invoices/:id/cancel`
- [ ] `POST /api/v1/invoices/:id/approve` — manager approves pending_approval
- [ ] `POST /api/v1/invoices/:id/reject` — manager rejects, sends back to rep as `draft` with reason
- [ ] `POST /api/v1/invoices/:id/override` — manager overrides discount/total (audited)
- [ ] `GET /api/v1/invoices/:id/audit` — full approval timeline
- [ ] `GET /api/v1/invoices/export?from=&to=&format=xlsx` — bulk export with line-item detail

### Permissions
- [ ] Reps: create + edit own drafts + confirm
- [ ] Managers: approve/reject/override
- [ ] Admins: everything + cancel any

### Acceptance
- [ ] Create draft → add lines → confirm → invoice locked + auto-anomaly-call placeholder fires
- [ ] Manager approves → status confirmed, audit row written
- [ ] Edit while not draft is rejected with 409
- [ ] XLSX export downloads with N rows × line-items
- [ ] Bridge: confirmed invoice can have a `voucher_headers.invoice_id` set (manual or trigger TBD)
