# API — Plan 04 · Products, Categories, Van Stock, Pricing

> Shared envelopes in [`docs/api/00.5-preflight.md`](./00.5-preflight.md).

Base URL: `/api/v1/`. All routes require `Authorization: Bearer <jwt>`.

**Money:** all prices are INTEGER **fils** (1 JOD = 1000 fils). The legacy
`items` module (`/api/v1/items`) is untouched and still works; this plan adds a
richer `products` view over the same `item_cart` table plus categories, van
stock, and pricing rules.

---

## Products — `/api/v1/products`

### `GET /api/v1/products`
**Query**: `q` (sku/name/name_ar/barcode), `categoryId`, `isActive`, `limit` (≤200, def 50), `offset`.
**Response data**: `{ items: Product[], total }`.

`Product` (selected): `id, itemNumber, sku, barcode, name, nameAr, nameEn, categoryId, unit, unitOfMeasure, price (fils), cost (fils), imageUrl, isActive, reorderQty, taxType, taxCategory, taxRate, ...`
**Errors**: `400`, `401`.

### `GET /api/v1/products/:id`
**Errors**: `400`, `401`, `404`.

### `POST /api/v1/products/:id/quote` — pricing engine
**Body** (`QuotePriceDto`): `{ qty (≥1), customerId? }`.
If `customerId` is given, its RFM segment (from `customer_ai_profile`) is resolved and segment-specific rules apply.
**Response data**:
```ts
{
  productId, qty, segment,
  listUnitPrice,    // fils, product.price
  appliedRuleId,    // null if no rule beat list price
  discountPct,
  finalUnitPrice,   // fils
  lineTotal         // finalUnitPrice * qty
}
```
**Errors**: `400`, `401`, `404`.

```bash
curl -X POST http://localhost:3000/api/v1/products/$PID/quote \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"qty":10}'
```

### `POST /api/v1/products` — `@Roles('admin','manager')`
**Body** (`CreateProductDto`): `itemNumber` + `barcode` + `name` + `price` (fils) required; `sku` defaults to `itemNumber`, `nameAr` to `name`; optional `nameEn, categoryId, unit, unitOfMeasure, cost, imageUrl, isActive, reorderQty, taxType (TAXABLE|INCLUSIVE|EXEMPT), taxCategory (S|Z|E), taxRate (0..1)`.
`taxPercentage` (legacy) is kept in sync from `taxRate`.
**Response** — `201`, `data: Product`. **Errors**: `400`, `401`, `403`, `409` (dup itemNumber).

### `PATCH /api/v1/products/:id` — `@Roles('admin','manager')`
Partial (cannot change `itemNumber`). **Errors**: `400`, `401`, `403`, `404`.

### `DELETE /api/v1/products/:id` — `@Roles('admin')`
Soft delete. `204`. **Errors**: `400`, `401`, `403`, `404`.

---

## Categories — `/api/v1/product-categories`

### `GET /api/v1/product-categories`
Returns the category **tree** (roots with nested `children[]`).
**Response data**: `CategoryNode[]` where `CategoryNode = ProductCategory & { children: CategoryNode[] }`.
**Errors**: `401`.

### `POST /api/v1/product-categories` — `@Roles('admin','manager')`
**Body**: `{ nameAr, nameEn?, parentId?, sortOrder? }`. **Errors**: `400`, `401`, `403`.

### `PATCH /api/v1/product-categories/:id` — `@Roles('admin','manager')`
### `DELETE /api/v1/product-categories/:id` — `@Roles('admin')` (`204`)

---

## Van Stock — `/api/v1/reps/:repId/van-stock`

### `GET /api/v1/reps/:repId/van-stock`
Current quantities per product on a rep's van.
**Response data**: `VanStockRow[]`:
```ts
{ productId, sku, nameAr, quantity, reorderQty,
  status: 'sufficient' | 'borderline' | 'stockout', snapshotAt }
```
Status: `stockout` (qty ≤ 0), `borderline` (qty ≤ reorderQty when reorderQty > 0), else `sufficient`.
**Errors**: `400`, `401`, `404` (rep).

### `POST /api/v1/reps/:repId/van-stock/load` — `@Roles('admin','manager')`
**Body**: `{ items: [{ productId, quantity (≥1) }] }` (≤500). Adds quantity (upsert).
**Response data**: `{ updated: number }`. **Errors**: `400`, `401`, `403`, `404`.

### `POST /api/v1/reps/:repId/van-stock/return` — `@Roles('admin','manager')`
Same body; subtracts quantity (clamped at 0).

---

## Price Rules — `/api/v1/price-rules`

A rule with NULL `productId` applies to all products; NULL `customerSegment`
applies to all segments. `fixedPrice` (fils) overrides `discountPct`. The quote
engine picks the rule yielding the lowest final unit price.

### `GET /api/v1/price-rules`
**Response data**: `PriceRule[]`.

### `POST /api/v1/price-rules` — `@Roles('admin','manager')`
**Body** (`CreatePriceRuleDto`):
```ts
{ productId?, customerSegment?, minQty? (≥1, def 1),
  discountPct? (0..100), fixedPrice? (fils), validFrom?, validTo? }
```
**Errors**: `400`, `401`, `403`.

### `PATCH /api/v1/price-rules/:id` — `@Roles('admin','manager')`
### `DELETE /api/v1/price-rules/:id` — `@Roles('admin')` (`204`)

---

## Swagger

All endpoints render at `/docs` under tags `products`, `product-categories`,
`van-stock`, `price-rules`.
