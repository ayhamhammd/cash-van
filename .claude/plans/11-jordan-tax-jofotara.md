# Plan 11 — Jordan Tax Calculation & JoFotara (ISTD) Integration

Spec ref: `.claude/Jordan_Tax_JoFotara_NodeJS_Spec.md`
Depends on: 01 (seller TIN + JoFotara creds in `app_settings`), 03 (buyer TIN/NIN), 04 (tax fields), 06 (invoices + jofotara_* fields)

> **Single-tenant adaptations:**
> - No `tenant_id` / no RLS. `UNIQUE (tenant_id, x)` → `UNIQUE (x)`.
> - Seller info + JoFotara creds live in **`app_settings`** (plan 01), not `tenants`. `SettingsService` exposes them (new `getJoFotaraCredentials()` decrypts the secret for internal use).
> - **Reuse, don't rebuild:** the tax engine is already `invoice-calculator.ts` (plan 06); `currency.util.ts` (filsToJod/jodToFils) and `secret.util.ts` (AES) already exist. This plan adds the validator, payload builder, ISTD client, credit notes, ledger.
> - **Queue:** pg-boss (`JobsService`), not Bull. Submission also exposed synchronously via a manual submit/retry endpoint for testability.
> - **ISTD HTTP is mock-mode by default** (`JOFOTARA_MOCK=true`) because the real ISTD API contract/URLs are unverified. Mock returns a deterministic VALIDATED + fake QR so the full pipeline (validate → build → submit → writeback → ledger) is testable now. Flip `JOFOTARA_MOCK=false` once real sandbox creds + contract are confirmed.
> - Report export: JSON report + XLSX (reuse exceljs); PDF deferred.

## Goal

Layer **Jordan VAT calculation** and **JoFotara (ISTD) e-invoicing** on top of the sales invoice pipeline. Plan 06 stores tax/JoFotara fields and triggers events; this plan owns the validator, the ISTD HTTP client, credit notes, and the tax ledger.

## Architecture decisions

- **Money: INTEGER fils everywhere.** 1 JOD = 1000 fils. Conversion to `'1.234'` JOD strings happens **only** in `JoFotaraBuilderService`. Util: `src/common/utils/currency.util.ts` exposes `filsToJod(n) → string`, `jodToFils(s) → number`.
- **Submission is asynchronous.** Confirm an invoice → enqueue ISTD job → ISTD response writes back. Never block `POST /invoices/:id/confirm` on the ISTD call.
- **Retry policy:** exponential backoff (1s, 5s, 30s, 5m, 30m, 2h) up to 6 tries. After exhaustion → `jofotara_status='ERROR'`, surface in dashboard approval queue for manual reconcile.
- **Sandbox vs prod base URL** chosen per-tenant from `tenants.jofotara_sandbox`.

## Tables

### New: `credit_notes`
```
id UUID PK, tenant_id UUID NOT NULL,
credit_note_number TEXT NOT NULL,
original_invoice_id UUID NOT NULL FK→invoices,
rep_id UUID NOT NULL FK→reps,
customer_id UUID NOT NULL FK→customers,
reason TEXT NOT NULL,

-- Totals (fils, INTEGER) — same shape as invoices
subtotal INT, total_line_discounts INT,
net_after_line_discounts INT,
total_return_tax INT,
grand_return_total INT,

-- JoFotara
invoice_type_code TEXT NOT NULL DEFAULT '381',
jofotara_uuid UUID,
jofotara_status TEXT NOT NULL DEFAULT 'PENDING',
jofotara_qr_code TEXT,
jofotara_registration_number TEXT,
jofotara_error_code TEXT,
jofotara_error_message TEXT,
jofotara_submitted_at TIMESTAMPTZ,

issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
deleted_at TIMESTAMPTZ,
UNIQUE (tenant_id, credit_note_number)
```

### New: `credit_note_lines`
Same shape as `invoice_lines` minus invoice_id; FK to `credit_notes`. Quantity references back to a specific `invoice_line_id` so the `returnable_qty` view can subtract.
```
id BIGSERIAL PK, credit_note_id UUID FK→credit_notes,
invoice_line_id BIGINT FK→invoice_lines,
product_id UUID FK→item_cart,
quantity NUMERIC(14,3), unit_price INT, unit_of_measure TEXT,
tax_type TEXT, tax_category TEXT, tax_rate NUMERIC(5,4),
subtotal INT, line_discount_amount INT,
net_after_line_discount INT, taxable_base INT,
tax_amount INT, line_total INT
```

### New: `tax_ledger_entries`
Append-only ledger for monthly ISTD filing.
```
id UUID PK, tenant_id UUID NOT NULL,
entry_type TEXT NOT NULL,             -- SALE | RETURN
document_kind TEXT NOT NULL,          -- INVOICE | CREDIT_NOTE
document_id UUID NOT NULL,            -- invoice_id or credit_note_id
document_number TEXT NOT NULL,
reference_document_number TEXT,       -- credit note → original invoice number
entry_date DATE NOT NULL,
buyer_name TEXT, buyer_tin TEXT,
taxable_amount INT NOT NULL,          -- negative for returns
tax_amount INT NOT NULL,              -- negative for returns
grand_total INT NOT NULL,             -- negative for returns
jofotara_status TEXT NOT NULL,
qr_code TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT now()
```
Only entries with `jofotara_status='VALIDATED'` are included in the monthly report.

### New: `jofotara_submission_log`
Every HTTP call audit (debugging + ISTD-side dispute resolution).
```
id BIGSERIAL PK, tenant_id UUID NOT NULL,
document_kind TEXT NOT NULL,          -- INVOICE | CREDIT_NOTE
document_id UUID NOT NULL,
attempt INT NOT NULL,
request_url TEXT, request_payload JSONB,
response_status INT, response_body JSONB,
duration_ms INT,
error TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

## Checklist

### Deps
- [ ] `npm i axios dayjs uuid @nestjs/bull bull ioredis @nestjs/schedule`
- [ ] `npm i -D @types/uuid`

### Migration
- [ ] `<ts>-AddCreditNotesTaxLedgerJoFotara.ts`
- [ ] `CREATE TABLE credit_notes`, `credit_note_lines`, `tax_ledger_entries`, `jofotara_submission_log`
- [ ] Indexes:
  - [ ] `credit_notes (tenant_id, original_invoice_id)`
  - [ ] `credit_notes (tenant_id, jofotara_status, jofotara_submitted_at)`
  - [ ] `credit_note_lines (credit_note_id)`, `(invoice_line_id)`
  - [ ] `tax_ledger_entries (tenant_id, entry_date, jofotara_status)`
  - [ ] `jofotara_submission_log (document_id, attempt)`
- [ ] View: `CREATE VIEW invoice_line_returnable_qty AS SELECT il.id AS invoice_line_id, il.quantity - COALESCE(SUM(cnl.quantity), 0) AS returnable_qty FROM invoice_lines il LEFT JOIN credit_note_lines cnl ON cnl.invoice_line_id = il.id GROUP BY il.id, il.quantity`
- [ ] Enable RLS on all four tables

### Module
- [ ] `src/modules/tax/tax.module.ts`
- [ ] Sub-services:
  - [ ] `TaxCalculatorService` — port of spec §5 (line + invoice + credit-note math, fils-based). **Must produce identical totals to the spec's TS reference when fed equivalent inputs.**
  - [ ] `InvoiceValidatorService` — port of spec §9 (seller TIN required; buyer ID required ≥ 10_000_000 fils; line sanity; zero-rate vs zero-category check)
  - [ ] `JoFotaraBuilderService` — port of spec §6 (builds the JSON payload; only place fils→JOD string conversion happens)
  - [ ] `JoFotaraApiService` — port of spec §7 (axios client; sandbox/prod base URL; returns `{ success, qrCode, registrationNumber, errorCode, errorMessage }`)
  - [ ] `JoFotaraSubmissionService` — orchestrates queue + retries + log + writeback
  - [ ] `CreditNoteService` — create/submit returns
  - [ ] `TaxLedgerService` — post entries, monthly report (port of spec §8)
- [ ] Shared: `src/common/utils/currency.util.ts` — `filsToJod`, `jodToFils`, `formatJodString`
- [ ] Crypto: `src/common/crypto/secret.util.ts` — AES-GCM for `jofotara_secret_key_encrypted`; key from `JOFOTARA_KMS_KEY` env (require 32-byte hex)

### Event wiring
- [ ] Listen for `invoice.confirmed` event (emitted by plan 06)
- [ ] Listen for `credit_note.created`
- [ ] Both push to Bull queue `jofotara-submit` with `{ tenant_id, kind, document_id, attempt: 1 }`
- [ ] Queue processor: load doc → build payload → submit → write back → on failure schedule next attempt

### Background jobs
- [ ] Bull queue `jofotara-submit` with retry strategy described above
- [ ] Cron: nightly reconcile job — re-poll any `jofotara_status='SUBMITTED'` older than 1h (in case webhook missed)
- [ ] Cron: monthly archive — after `JordanTax.ARCHIVE_YEARS=4` years, cold-storage old entries

### DTOs
- [ ] `CreateCreditNoteDto` — `{ original_invoice_id, reason, lines: [{ invoice_line_id, return_quantity }] }`
- [ ] `JoFotaraStatusDto` — read model for invoice + credit_note
- [ ] `MonthlyTaxReportDto` — `{ period_from, period_to, total_sales, total_sales_tax, total_returns, total_returns_tax, net_output_tax, invoice_count, credit_note_count }`
- [ ] `TaxLedgerEntryDto`

### Endpoints

**Credit notes**
- [ ] `POST /api/v1/credit-notes` — create + submit (manager only)
- [ ] `GET /api/v1/credit-notes` — list + filters
- [ ] `GET /api/v1/credit-notes/:id`
- [ ] `GET /api/v1/invoices/:id/credit-notes` — all credit notes for one invoice
- [ ] `GET /api/v1/invoices/:id/returnable` — returns each line's remaining returnable qty

**JoFotara**
- [ ] `POST /api/v1/jofotara/invoices/:id/retry` — admin force-retry a failed submission
- [ ] `GET /api/v1/jofotara/submissions/:document_id/log` — submission attempts log
- [ ] `POST /api/v1/jofotara/test-credentials` — health-check tenant's ISTD credentials (calls a known no-op or 401-on-bad-key endpoint)

**Tax reporting**
- [ ] `GET /api/v1/tax/report?year=&month=` — monthly net-output-tax report (admin/manager)
- [ ] `GET /api/v1/tax/ledger?from=&to=&entry_type=` — paginated ledger view
- [ ] `GET /api/v1/tax/report/export?year=&month=&format=xlsx|pdf` — file export for ISTD filing

### Permissions
- [ ] Credit-note create: manager+
- [ ] Tax report read: manager+
- [ ] JoFotara credential set/rotate: admin only (already covered in plan 01)
- [ ] Force-retry submission: admin only

### Determinism tests (critical)
- [ ] Port the spec's example scenarios into Jest tests:
  - [ ] Single TAXABLE line, no discounts → expected tax
  - [ ] INCLUSIVE-only invoice (tax extraction) → expected extracted tax
  - [ ] Mixed TAXABLE + INCLUSIVE + EXEMPT with line discounts and invoice discount → expected breakdown
  - [ ] Partial return (1 of 2 phones) → expected reversed tax
  - [ ] Monthly summary with 2 sales + 1 return → `net_output_tax = sales_tax + returns_tax (negative)`
- [ ] Each test asserts in fils (integer) AND in the JoFotara JOD-string payload (string equality).

### Acceptance
- [ ] Migration up/down clean; views resolve
- [ ] Confirm an invoice → background job submits to ISTD sandbox → `jofotara_status='VALIDATED'`, QR code stored
- [ ] Force a transient ISTD failure (e.g. point at unreachable URL) → 6 retries logged in `jofotara_submission_log`, final state `ERROR`
- [ ] Create credit note for 1 of 2 returned units → `returnable_qty` view shows 1 left
- [ ] Monthly report: 2 sales + 1 return → `net_output_tax` matches `sum(sales_tax) - sum(return_tax)`
- [ ] Validator rejects: missing seller TIN; invoice ≥ 10_000_000 fils with no buyer TIN/NIN/PN; line with qty=0
- [ ] Builder payload matches the spec's example output byte-for-byte for a fixed fixture
- [ ] Rotating JoFotara secret via `PATCH /tenants/me/jofotara` — old key never readable, new key works on next submission
- [ ] Per-feature deliverables produced: `docs/api/11-jordan-tax-jofotara.md` (with Swagger) and `docs/test-plans/11-jordan-tax-jofotara.md` (manual test guide with cURL examples)
