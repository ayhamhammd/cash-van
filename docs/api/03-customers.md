# API — Plan 03 · Customers + AI Profile + Visits

> Shared envelopes (success + error) are in [`docs/api/00.5-preflight.md`](./00.5-preflight.md).

Base URL: `/api/v1/`. All routes require `Authorization: Bearer <jwt>`.

The `customers` table was extended with VanFlow bilingual fields, JoFotara buyer
identity (`tin/nin/passportNumber/cityCode`), assignment (`repId/regionId`), and
AI-enrichment join targets. Two new tables back this plan: `customer_ai_profile`
(written by the AI pipeline) and `customer_visits` (mobile check-ins).

**PII note:** `phone` is stored raw, plus a non-reversible `phone_hash`
(HMAC-SHA256). The hash column has `select: false` and is never returned by the
API — AI calls reference it instead of the raw number.

---

## Customers — `/api/v1/customers`

### `GET /api/v1/customers`

**Query**
| Param | Type | Notes |
|---|---|---|
| `q` | string | substring on `nameAr / nameEn / customerNumber` (ILIKE + trigram) |
| `segment` | string | RFM segment (requires AI profile) |
| `churnRisk` | `loyal\|at_risk\|high_risk` | requires AI profile |
| `regionId` | uuid | |
| `repId` | uuid | |
| `isActive` | boolean | |
| `limit` | int | 1–200, default 25 |
| `offset` | int | ≥ 0, default 0 |

**Response data**: `{ items: Customer[], total: number }`

`Customer` (selected fields): `id, customerNumber, customerName, nameAr, nameEn, phone, addressAr, city, cityCode, location, longitude, latitude, repId, regionId, category, creditLimit, paymentTerms, customerType, totalDebt, totalCredit, tin, nin, passportNumber, isActive, createdAt, updatedAt, deletedAt, version`. (`phoneHash` is never included.)

**Possible errors**: `400 BadRequestException`, `401 UnauthorizedException`.

```bash
# Arabic search — URL-encode the query
curl "http://localhost:3000/api/v1/customers?q=%D9%86%D9%88%D8%B1" -H "Authorization: Bearer $TOKEN"
```

### `GET /api/v1/customers/:id`
**Response data**: `Customer`. **Errors**: `400`, `401`, `404 NotFoundException`.

### `GET /api/v1/customers/:id/insights`
Customer AI panel.
**Response data**:
```ts
{
  customer: Customer;
  aiProfile: {
    customerId, segment, churnScore, churnRiskLabel,
    ltvEstimate, shapDriversJson, modelVersion, computedAt, updatedAt
  } | null;
  recentVisits: CustomerVisit[];          // last 10
  invoiceSummary: { count, totalFils };   // zeros until plan 06
  collectionSummary: { outstandingFils, overdueFils }; // zeros until plan 07
}
```
**Errors**: `400`, `401`, `404`.

### `POST /api/v1/customers` — `@RequirePermissions('canAddCustomer')`
**Request body** (`CreateCustomerDto`): `customerNumber` + `customerName` required; `nameAr` defaults to `customerName`; optional `nameEn, phone, addressAr, city, cityCode, location, longitude, latitude, repId, regionId, category, creditLimit, paymentTerms, customerType, tin, nin, passportNumber, isActive`.
`phone_hash` is computed automatically.
**Response** — `201`, `data: Customer`.
**Errors**: `400`, `401`, `403 ForbiddenException`, `409 ConflictError` (duplicate number).

### `PATCH /api/v1/customers/:id` — `@RequirePermissions('canEditCustomerCredit')`
Partial update (cannot change `customerNumber`). Re-hashes `phone` if provided.
**Errors**: `400`, `401`, `403`, `404`.

### `POST /api/v1/customers/:id/reassign` — `@Roles('admin','manager')`
**Body**: `{ newRepId: uuid }` → sets `repId`.
**Response data**: updated `Customer`.
**Errors**: `400`, `401`, `403`, `404`.

### `DELETE /api/v1/customers/:id`
Soft delete. **Response** — `204`. **Errors**: `400`, `401`, `404`.

---

## Visits — `/api/v1/customers/:id/visits`

### `GET /api/v1/customers/:id/visits`
**Response data**: `CustomerVisit[]` (latest 50, desc).

`CustomerVisit`: `{ id, customerId, repId, visitedAt, hadSale, visitNote, lat, lng }`

### `POST /api/v1/customers/:id/visits`
**Body** (`CreateVisitDto`): `{ repId (required), visitedAt?, hadSale?, visitNote?, lat?, lng? }`.
**Response** — `201`, `data: CustomerVisit`.
**Errors**: `400`, `401`, `404`.

---

## AI refresh + CSV import

### `POST /api/v1/customers/:id/refresh-ai` — `@Roles('admin','manager')`
Enqueues a `customer-ai-profile-refresh` pg-boss job. The real model lands in
plan 08; for now a stub worker drains the queue.
**Response data**: `{ queued: boolean }` (`false` if jobs disabled).
**Errors**: `400`, `401`, `403`, `404`.

### `POST /api/v1/customers/import` — `@Roles('admin','manager')`
`multipart/form-data`, field `file` = CSV.
Columns: `number,name,address,phone,category` (header row required).
Good rows commit in one transaction; bad/duplicate rows are reported.
**Response data**:
```ts
{ inserted: number; skipped: number; errors: { row: number; reason: string }[] }
```
Limits: ≤ 5000 data rows.
**Errors**: `400` (malformed CSV, empty, > 5000 rows), `401`, `403`.

```bash
curl -X POST http://localhost:3000/api/v1/customers/import \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@customers.csv;type=text/csv"
```

---

## Internal: AI profile upsert

`CustomersService.upsertAiProfile(profile)` is not an HTTP endpoint — it's called
by the AI pipeline (plan 08). Writes one row per customer keyed on `customerId`.
Tests and the pipeline use it to populate `customer_ai_profile`.

---

## Swagger

All endpoints render at `/docs` with Bearer auth and request/response shapes.
The CSV import uses `@ApiConsumes('multipart/form-data')` with a binary `file` field.
