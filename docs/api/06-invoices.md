# API — Plan 06 · Sales Invoices & Approval

> Shared envelopes in [`docs/api/00.5-preflight.md`](./00.5-preflight.md).

Base URL: `/api/v1/`. All routes require `Authorization: Bearer <jwt>`.

All money is INTEGER **fils**. Tax is computed by `InvoiceCalculator` (a fils
port of the Jordan tax spec §5): TAXABLE adds tax on top, INCLUSIVE extracts
embedded tax, EXEMPT none; per-line discounts and a header invoice discount are
supported, the invoice discount distributed proportionally into lines so the
per-line tax always sums to the invoice tax.

Two independent statuses:
- `status` (workflow): `draft → confirmed → (pending_approval) → rejected/cancelled`
- `jofotara_status` (ISTD): `PENDING → SUBMITTED → VALIDATED/REJECTED/ERROR` (driven by plan 11)

---

## `GET /api/v1/invoices`
**Query**: `repId, customerId, status, from, to (ISO), limit (≤200, def 25), offset`.
**Response data**: `{ items: Invoice[], total }`.
`Invoice` includes totals (`subtotal, totalLineDiscounts, invoiceDiscountAmount, netTaxable, netInclusive, netExempt, taxOnTaxable, taxExtractedFromInclusive, totalTax, grandTotal`), `status`, `invoiceNumber`, JoFotara fields, and (on `/:id`) `lines`.
**Errors**: `400`, `401`.

## `GET /api/v1/invoices/:id`
One invoice with `lines[]`. **Errors**: `400`, `401`, `404`.

## `GET /api/v1/invoices/:id/audit`
Approval timeline. **Response data**: `InvoiceApproval[]` (`{ id, invoiceId, action, actorId, reason, actedAt }`), `action ∈ submitted|approved|rejected|override`. **Errors**: `400`, `401`, `404`.

## `GET /api/v1/invoices/export?from=&to=` — `@Roles('admin','manager')`
Streams an `.xlsx` (one row per line item; values in JOD). `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. **Errors**: `401`, `403`.

```bash
curl -s -o invoices.xlsx -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/v1/invoices/export?from=2026-01-01&to=2026-12-31"
```

## `POST /api/v1/invoices`
Create a draft (any authenticated user). Computes all tax/totals.
**Body** (`CreateInvoiceDto`):
```ts
{
  repId: uuid,
  customerId: uuid,
  lines: [{
    productId: uuid,
    quantity: number,          // fractional ok
    unitPrice?: number,        // fils; defaults to product.price
    lineDiscountType?: 'PERCENTAGE'|'FIXED_AMOUNT',
    lineDiscountValue?: number // pct or fils
  }],                          // 1..200
  invoiceDiscountType?: 'PERCENTAGE'|'FIXED_AMOUNT',
  invoiceDiscountValue?: number,
  paymentMethodCode?: '012'|'022',  // cash | receivable
  note?, deviceId?
}
```
`invoiceNumber` auto-assigned as `INV-{YYYY}-{NNNNNN}`. **Response** — `201`, `data: Invoice`. Emits `invoice.created`.
**Errors**: `400` (unknown rep/customer/product), `401`.

## `PATCH /api/v1/invoices/:id`
Edit a **draft** only (recomputes tax). `repId`/`customerId` immutable.
**Errors**: `400`, `401`, `404`, `409` (not draft).

## `POST /api/v1/invoices/:id/confirm`
`draft → confirmed`. Sets `confirmedAt`, generates `jofotaraUuid`, writes a `submitted` audit row, emits `invoice.confirmed` (plan 08 anomaly + plan 11 JoFotara subscribe).
**Errors**: `400`, `401`, `404`, `409` (not draft).

## `POST /api/v1/invoices/:id/cancel` — `@Roles('admin','manager')`
Sets `status=cancelled`. Idempotent. **Errors**: `400`, `401`, `403`, `404`.

## `POST /api/v1/invoices/:id/approve` — `@Roles('admin','manager')`
`confirmed|pending_approval → confirmed`. Body `{ reason? }`. Writes `approved` audit. Emits `invoice.approved`.
**Errors**: `400`, `401`, `403`, `404`, `409`.

## `POST /api/v1/invoices/:id/reject` — `@Roles('admin','manager')`
Returns invoice to `draft`. Body `{ reason }` (required). Writes `rejected` audit. Emits `invoice.rejected`.
**Errors**: `400`, `401`, `403`, `404`, `409` (cancelled).

## `POST /api/v1/invoices/:id/override` — `@Roles('admin','manager')`
Sets a fixed invoice-level discount (fils) and **recomputes** all totals + line breakdowns. Body `{ invoiceDiscountAmount, reason? }`. Writes `override` audit.
**Errors**: `400`, `401`, `403`, `404`, `409` (cancelled).

---

## Legacy bridge

`voucher_headers.invoice_id` (nullable FK) links a sales invoice to its legacy
GL voucher. Populating it (trigger or service) is left for the GL-integration
task; the column exists so a future migration can wire the two flows.

## Swagger

All endpoints render at `/docs` under the `invoices` tag.
