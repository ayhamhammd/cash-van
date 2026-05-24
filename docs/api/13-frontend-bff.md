# API — Plan 13 · Mobile BFF (`/api/v1/mobile`)

Read endpoints shaped to the frontend contract ([`../../.claude/plans/12-frontend_API`]).
Field names follow that contract; values come from existing backend data.

> **Envelope is ours.** Every response is `{ success, data, timestamp }`; errors are
> `{ statusCode, message, error, path, timestamp }`. The contract's field names live
> **inside `data`**. (The frontend unwraps `data`.)

Base URL: `/api/v1/mobile`. All endpoints require `Authorization: Bearer <jwt>`.

## Common parameters (every endpoint)

| Param | Where | Required | Notes |
|---|---|---|---|
| `companyNumber` | query `companyNumber` **or** header `X-Company-Number` | ✅ | Must equal `app_settings.company_number` (single-tenant) |
| `salesmanCode` | path (salesman), query `salesmanCode`, **or** header `X-Salesman-Code` | ✅ | Resolves to a `reps.code` |

Validation (MobileContextGuard): missing param → `400`; unknown `companyNumber` →
`400`; unknown `salesmanCode` → `404`; a salesman token querying another salesman →
`403` (admin/manager may query any).

---

## GET `/mobile/salesman/{salesmanCode}`

Salesman profile + assigned route (region) + van store (warehouse) + price phase.

**Response `data`** (`SalesmanDto`):
| Field | Source |
|---|---|
| companyNumber | settings |
| salesmanCode | `reps.code` |
| salesmanNameAr / salesmanNameEn | `reps.nameAr/nameEn` |
| salesmanPhone | `reps.phone` |
| routeCode / routeNameAr / routeNameEn | `regions.code/nameAr/nameEn` (via `reps.regionId`) |
| storeNumber | `warehouses.whNumber` (via `reps.vanId`) |
| pricePhase | constant `"1"` (single-price build) |
| isActive | `reps.isActive` |

Example: `GET /mobile/salesman/S012?companyNumber=C001`
```json
{ "success": true, "data": {
  "companyNumber":"C001","salesmanCode":"S012",
  "salesmanNameAr":"أحمد المصري","salesmanNameEn":"Ahmad Al-Masri",
  "salesmanPhone":"0791234567","routeCode":"R-A01",
  "routeNameAr":"مسار وسط عمان","routeNameEn":"Central Amman Route",
  "storeNumber":"4","pricePhase":"1","isActive":true
}, "timestamp":"…" }
```

---

## GET `/mobile/company/meta`

Company header. Example: `GET /mobile/company/meta?companyNumber=C001&salesmanCode=S012`

**Response `data`** (`CompanyMetaDto`): `companyNumber`, `salesmanCode`,
`companyName` (`company_name_en` || `_ar`), `taxNumber` (`seller_tin`),
`companyPhone` (`seller_phone`), `logo` (`logo_url` or `""`).

---

## GET `/mobile/items/{itemCode}`

Full item detail. `itemCode` = `item_cart.item_number`. `404` if unknown.

**Response `data`** (`ItemDto`):
| Field | Source |
|---|---|
| itemCode | `item_cart.item_number` |
| itemNameAr / itemNameEn | `item_cart.name_ar/name_en` |
| itemPrice | `item_cart.price` (fils) → 3-dp string |
| itemBarcode | `item_cart.barcode` |
| itemPic | `item_cart.image_url` (→ `photo_url` → `""`) |
| itemCategory | `product_categories.name_en/name_ar` |
| taxPerc | `item_cart.tax_rate × 100` → e.g. `"16"` |
| itemUnits[] | `item_switch`: `unitName`, `unitCode`=barcode, `unitPrice`=sale_price (3-dp), `unitQty`=⌊van stock ÷ factor⌋ |
| itemPriceList[] | `[{ "phaseNumber":"1", "phasePrice": itemPrice }]` |

`unitQty` uses the salesman's van-store balance (0 until stock exists from posted vouchers).

---

## GET `/mobile/itemBalance`

Stock per store for an item. **Always an array** in `data` (even for one store).

| Query | Required | |
|---|---|---|
| `itemNumber` | ✅ | item to query |
| `storeNo` | ❌ | filter to one store; omit for all |

**Response `data`** — array of `{ companyNumber, salesmanCode, itemNumber, itemQty, storeNumber }`
from the `item_balance` view (rows with a non-null store). `itemQty` is an integer string.

---

## Admin setup (one-time per deployment / rep / item)

- `PATCH /settings` → `{ companyNumber, logoUrl }` (+ existing name/tin/phone).
- `PATCH /reps/{id}` → `{ code, regionId, vanId }`; `PATCH /regions/{id}` → `{ code }`.
- Items/units via `/products` + `/items/switches`; store balances accrue from posted vouchers.

## Swagger
`@ApiTags('mobile')` — all four endpoints with their DTO schemas at `/docs`.
