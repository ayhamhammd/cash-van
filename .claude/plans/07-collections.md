# Plan 07 — Cash & Cheque Collections

Spec ref: Part 3.7 (adapted for single-tenant deployment)
Depends on: [03 — Customers](./03-customers.md), [06 — Invoices](./06-invoices.md)

> **No `tenant_id` / no RLS** (single-tenant). Drop `tenant_id` columns + RLS.
> **Money = INTEGER fils.**
> **Cheque reconciliation is self-contained:** the `ai_cheque_scan_queue` (plan 08) doesn't exist yet, so reconciliation lives on the `cheques` table itself — `reconciled_at` / `reconciled_by` columns + a words-mismatch confirm-block. Plan 08 can later cross-reference local-vs-server OCR extracts; the queue here = cheques with `words_match = false AND reconciled_at IS NULL`.
> Tables do NOT extend `BaseEntity` — explicit columns (no `version`).

## Goal

Spec-compliant `collections` + `cheques`, replacing the rep-facing flow currently covered by `payments` + `payment_cheques`. Keep the legacy tables intact (they tie to the voucher/GL flow); add bridges so a `collection` can map to a `payment`.

## Existing → Target Mapping

| Spec | Existing | Action |
|---|---|---|
| `collections` | `payments` (voucher-bound) | new table; bridge via `collections.payment_id` nullable FK |
| `cheques` | `payment_cheques` | new table; bridge via `cheques.payment_cheque_id` nullable FK; cheques here are *collection*-bound (FK to `collections.id`) not voucher-bound |

## Tables

### `collections`
```
id UUID PK, tenant_id UUID, rep_id UUID FK→reps,
customer_id UUID FK→customers, invoice_id UUID FK→invoices NULL,
payment_id UUID FK→payments NULL,           -- bridge to legacy GL
amount INT, method TEXT,                     -- cash | cheque
status TEXT DEFAULT 'pending',               -- pending | confirmed | deposited | bounced
collected_at TIMESTAMPTZ, confirmed_at TIMESTAMPTZ,
deposited_at TIMESTAMPTZ, note TEXT
```

### `cheques`
```
id UUID PK, collection_id UUID FK→collections, bank_name TEXT,
cheque_number TEXT, payee TEXT, amount INT, amount_words TEXT,
due_date DATE, ocr_confidence REAL, words_match BOOLEAN,
scan_source TEXT,                            -- server | mlkit_offline
status TEXT DEFAULT 'pending',               -- pending | cleared | bounced | cancelled
image_path TEXT, scanned_at TIMESTAMPTZ,
payment_cheque_id UUID FK→payment_cheques NULL    -- bridge to legacy
```

## Checklist

### Migration
- [ ] `<ts>-AddCollectionsAndCheques.ts`
- [ ] `CREATE TABLE collections` with check on `method` and `status`
- [ ] `CREATE TABLE cheques` with check on `scan_source` and `status`
- [ ] Indexes:
  - [ ] `collections (tenant_id, rep_id, collected_at DESC)`
  - [ ] `collections (tenant_id, status, collected_at DESC)`
  - [ ] `collections (customer_id, status)`
  - [ ] `collections (invoice_id)` partial WHERE invoice_id IS NOT NULL
  - [ ] `cheques (collection_id)`, `(due_date)`, `(status)`
- [ ] Enable RLS

### Entities
- [ ] `src/modules/collections/entities/collection.entity.ts`
- [ ] `src/modules/collections/entities/cheque.entity.ts`

### Module
- [ ] `src/modules/collections/collections.module.ts` + service + controller
- [ ] `ReconciliationService`
  - [ ] Compares `ai_cheque_scan_queue.local_extract_json` vs `server_extract_json` (table from plan 08)
  - [ ] Surfaces mismatch queue
  - [ ] On `reconciled_at` write → unlocks cheque for confirm
- [ ] `AgingService` — buckets (0-7, 8-30, 31-60, 60+) for overdue collections

### DTOs
- [ ] `CreateCollectionDto` — `{ customer_id, invoice_id?, amount, method, collected_at?, note?, cheque?: {...} }`
- [ ] `CreateChequeDto` (embedded above)
- [ ] `ConfirmCollectionDto` (empty)
- [ ] `MarkDepositedDto` — `{ collection_ids: [] }` bulk
- [ ] `ReconcileChequeDto` — `{ reconciled_amount, reconciled_amount_words, reconciled_bank, reconciled_cheque_number, reconciled_due_date }`

### Endpoints — Collections
- [ ] `GET /api/v1/collections` — filters `?rep_id&customer_id&method&status&from&to`
- [ ] `GET /api/v1/collections/:id`
- [ ] `POST /api/v1/collections` (cash or cheque)
- [ ] `POST /api/v1/collections/:id/confirm`
- [ ] `POST /api/v1/collections/batch-deposit` — bulk mark deposited
- [ ] `GET /api/v1/collections/summary?date=` — Total | Cash | Cheque | Pending | Overdue
- [ ] `GET /api/v1/collections/aging` — bucketed report

### Endpoints — Cheques
- [ ] `GET /api/v1/cheques?status=&due_from=&due_to=`
- [ ] `GET /api/v1/cheques/reconcile/queue` — rows needing manager review
- [ ] `POST /api/v1/cheques/:id/reconcile` — confirms final values, sets `reconciled_at` on linked queue row
- [ ] `POST /api/v1/cheques/:id/mark-cleared`
- [ ] `POST /api/v1/cheques/:id/mark-bounced`
- [ ] `GET /api/v1/cheques/export/bank` — IBAN + amount + due_date list (XLSX/CSV)

### Mismatch handling
- [ ] If `cheques.words_match = FALSE` and `status = 'pending'` → block `POST /collections/:id/confirm` with 409 until reconciliation done.

### Acceptance
- [ ] Create cash collection → confirm → mark deposited
- [ ] Create cheque collection with OCR fields → reconciliation queue surfaces mismatch → reconcile → confirm works
- [ ] Aging report buckets sum to total outstanding
- [ ] Bank-export CSV downloads with correct schema
- [ ] Migration up/down clean
