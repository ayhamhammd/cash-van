# API — Plan 07 · Cash & Cheque Collections

> Shared envelopes in [`docs/api/00.5-preflight.md`](./00.5-preflight.md).

Base URL: `/api/v1/`. All routes require `Authorization: Bearer <jwt>`. Money in
INTEGER **fils**.

A `collection` is a cash or cheque payment from a customer (optionally tied to an
invoice). Cheque collections also create a `cheque` row with OCR metadata and a
words-match flag. Lifecycle: `pending → confirmed → deposited` (or `bounced`).

---

## Collections — `/api/v1/collections`

### `GET /api/v1/collections`
**Query**: `repId, customerId, method (cash|cheque), status, from, to (ISO), limit (≤200), offset`.
**Response data**: `{ items: Collection[], total }` (each with `cheque` if any).
`Collection`: `{ id, repId, customerId, invoiceId, paymentId, amount, method, status, collectedAt, confirmedAt, depositedAt, note, cheque? }`.
**Errors**: `400`, `401`.

### `GET /api/v1/collections/summary?date=YYYY-MM-DD`
Daily totals (default today).
**Response data**: `{ date, totalCollectedFils, cashFils, chequeFils, pendingFils, overdueChequeFils }`.
`overdueChequeFils` = pending cheques whose `due_date < today`.
**Errors**: `401`.

### `GET /api/v1/collections/aging`
Uncleared-cheque aging by days past `due_date`.
**Response data**:
```ts
{
  asOf: 'YYYY-MM-DD',
  buckets: [{ label: '0-7'|'8-30'|'31-60'|'60+', count, amountFils }],
  totalOutstandingFils
}
```
**Errors**: `401`.

### `GET /api/v1/collections/:id`
One collection (with cheque). **Errors**: `400`, `401`, `404`.

### `POST /api/v1/collections`
Record a cash or cheque collection.
**Body** (`CreateCollectionDto`):
```ts
{
  repId, customerId, invoiceId?,
  amount,                 // fils, > 0
  method: 'cash' | 'cheque',
  collectedAt?, note?,
  cheque?: {              // required when method='cheque'
    bankName?, chequeNumber?, payee?, amountWords?, dueDate?,
    ocrConfidence?, wordsMatch?,   // wordsMatch=false flags a mismatch
    scanSource?: 'server'|'mlkit_offline', imagePath?
  }
}
```
**Response** — `201`, `data: Collection`. **Errors**: `400` (missing cheque / unknown rep|customer), `401`.

### `POST /api/v1/collections/:id/confirm`
`pending → confirmed`. **Blocked** with `409` if the linked cheque has
`wordsMatch=false` and is not yet reconciled.
**Errors**: `400`, `401`, `404`, `409`.

### `POST /api/v1/collections/batch-deposit` — `@Roles('admin','manager')`
Mark multiple **confirmed** collections as `deposited`.
**Body**: `{ collectionIds: uuid[] }`.
**Response data**: `{ deposited: number, skipped: string[] }` (non-confirmed ids are skipped).
**Errors**: `400`, `401`, `403`.

---

## Cheques — `/api/v1/cheques`

### `GET /api/v1/cheques`
**Query**: `status, dueFrom, dueTo (YYYY-MM-DD)`. **Response data**: `Cheque[]`.
`Cheque`: `{ id, collectionId, bankName, chequeNumber, payee, amount, amountWords, dueDate, ocrConfidence, wordsMatch, scanSource, status, imagePath, scannedAt, reconciledAt, reconciledBy, paymentChequeId }`.

### `GET /api/v1/cheques/reconcile/queue` — `@Roles('admin','manager')`
Cheques with `wordsMatch=false AND reconciledAt IS NULL`. **Response data**: `Cheque[]`.

### `GET /api/v1/cheques/export/bank` — `@Roles('admin','manager')`
CSV clearing list of **pending** cheques: `bank_name,cheque_number,payee,amount_jod,due_date`. `Content-Type: text/csv`.

### `POST /api/v1/cheques/:id/reconcile` — `@Roles('admin','manager')`
Confirm the correct values; sets `wordsMatch=true`, `reconciledAt`, `reconciledBy` — clears the confirm block.
**Body** (`ReconcileChequeDto`): `{ amount (fils), amountWords?, bankName?, chequeNumber?, dueDate? }`.
**Errors**: `400`, `401`, `403`, `404`.

### `POST /api/v1/cheques/:id/mark-cleared` — `@Roles('admin','manager')`
### `POST /api/v1/cheques/:id/mark-bounced` — `@Roles('admin','manager')`
Set cheque `status`. **Errors**: `400`, `401`, `403`, `404`.

---

## Legacy bridges

- `collections.payment_id` → legacy GL `payments.id` (nullable; populated by a GL-integration task).
- `cheques.payment_cheque_id` → legacy `payment_cheques.id` (nullable).

## Future (plan 08)

The AI cheque-scan queue (`ai_cheque_scan_queue`) will let reconciliation
cross-reference local (ML Kit offline) vs server (Vision API) OCR extracts. For
now reconciliation is manual against the `cheques` row itself.

## Swagger

All endpoints render at `/docs` under tags `collections` and `cheques`.
