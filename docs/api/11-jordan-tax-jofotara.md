# API — Plan 11 · Jordan Tax & JoFotara (ISTD)

> Shared envelopes in [`docs/api/00.5-preflight.md`](./00.5-preflight.md).

Base URL: `/api/v1/`. All routes require `Authorization: Bearer <jwt>`. Money in
INTEGER **fils**; JOD strings appear only inside the JoFotara payload.

## How submission works

1. An invoice is confirmed (plan 06) → emits `invoice.confirmed`.
2. `JoFotaraSubmissionService` validates (Jordan rules) → builds the ISTD JSON
   payload → submits → logs the attempt → writes back
   `jofotara_status / qr_code / registration_number` → on `VALIDATED`, posts to
   the `tax_ledger`.
3. Same flow for credit notes via `credit_note.created`.

**Mock mode:** `JOFOTARA_MOCK=true` (default) returns a deterministic
`VALIDATED` + fake QR so the whole pipeline runs without real ISTD access. Set
`JOFOTARA_MOCK=false` (plus seller TIN + JoFotara credentials in Settings, and a
**verified** ISTD API contract) to submit for real.

Seller identity + credentials come from `/api/v1/settings` (plan 01).

---

## Credit notes — `/api/v1/credit-notes`

### `POST /api/v1/credit-notes` — `@Roles('admin','manager')`
Create a return against a confirmed invoice; computes return tax via the shared
calculator and auto-submits to ISTD.
**Body** (`CreateCreditNoteDto`):
```ts
{
  originalInvoiceId: uuid,
  reason: string,
  lines: [{ invoiceLineId: string, returnQuantity: number }]  // 1..200
}
```
Validates each `returnQuantity ≤ remaining returnable`. Sets
`invoices.has_credit_notes = true`.
**Response** — `201`, `data: CreditNote` (totals: `subtotal, totalReturnTax, grandReturnTotal`, plus jofotara fields).
**Errors**: `400` (invalid invoice/line, qty exceeds returnable), `401`, `403`.

### `GET /api/v1/credit-notes` · `GET /api/v1/credit-notes/:id`
List / fetch (with lines).

### `GET /api/v1/invoices/:id/credit-notes`
All credit notes against an invoice.

### `GET /api/v1/invoices/:id/returnable`
Remaining returnable qty per line.
**Response data**: `[{ invoiceLineId, productId, originalQty, returnableQty }]`.

---

## JoFotara — `/api/v1/jofotara`

### `POST /api/v1/jofotara/invoices/:id/submit` — `@Roles('admin','manager')`
Submit/retry an invoice synchronously.
**Response data**: `{ status, qrCode?, registrationNumber?, errors? }`.
- `VALIDATED` → success (mock or real)
- `REJECTED` → validation errors (in `errors`)
- `ERROR` → ISTD call failed (retry later)

### `POST /api/v1/jofotara/credit-notes/:id/submit` — `@Roles('admin','manager')`
Same for a credit note.

### `GET /api/v1/jofotara/submissions/:documentId/log` — `@Roles('admin','manager')`
Every ISTD attempt for a document (invoice or credit note id):
`[{ attempt, requestUrl, requestPayload, responseStatus, responseBody, durationMs, error, createdAt }]`.

---

## Tax reporting — `/api/v1/tax` — `@Roles('admin','manager')`

### `GET /api/v1/tax/report?year=&month=`
Monthly net-output-tax (VALIDATED ledger entries only).
**Response data**:
```ts
{
  periodFrom, periodTo,
  totalSalesFils, totalSalesTaxFils,
  totalReturnsFils, totalReturnsTaxFils,   // negative
  netOutputTaxFils,                         // payable to ISTD
  invoiceCount, creditNoteCount
}
```

### `GET /api/v1/tax/ledger?from=&to=&entryType=`
Raw ledger entries (`SALE`/`RETURN`), amounts in fils (returns negative).

### `GET /api/v1/tax/report/export?year=&month=`
Monthly report as `.xlsx` (values in JOD).

---

## Settings dependency (plan 01)

- `PATCH /api/v1/settings` — set `sellerTin`, company name, address, city code.
- `PATCH /api/v1/settings/jofotara` — set/rotate `clientId` + `secretKey` (encrypted).
  The submission service decrypts these internally; they're never returned by the API.

## Going live checklist

1. Verify the real ISTD JoFotara API base URL + request/response contract.
2. Set seller TIN + JoFotara `clientId`/`secretKey` in Settings.
3. Set `JOFOTARA_MOCK=false`.
4. Submit a sandbox invoice; confirm a real QR + registration number come back.

## Swagger

All endpoints render at `/docs` under tags `credit-notes`, `jofotara`, `tax`.
