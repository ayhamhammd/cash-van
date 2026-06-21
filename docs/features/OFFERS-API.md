# Offers Engine — API Reference (backend)

> Status: **implemented** · Module: `src/modules/offers` · Swagger: `/docs` (tag **offers**) when `SWAGGER_ENABLED=true`.
> This is the concrete, authoritative contract the dashboard and mobile app are built against. It supersedes the idealized shapes in the design spec `OFFERS-FE.md` where they differ (notably: money is **integer fils**, a single `name` field, and `lineDiscountFils`/`unitPriceFils` on evaluate output).

All routes are under the global prefix `/api/v1`, require a Bearer JWT, and return the standard envelope:

```jsonc
{ "success": true, "data": <payload>, "timestamp": "2026-06-21T..." }
```

Money is **integer fils** (1 JOD = 1000 fils). Discount rewards: `PERCENT` → 0–100; `VALUE` → fils.

---

## Types

```ts
OfferType = 'ITEM_QTY_DISCOUNT' | 'BUY_X_GET_Y_FREE' | 'BASKET_THRESHOLD'
          | 'ITEM_SET_THRESHOLD' | 'LOYALTY_FIRST_PURCHASE'

Offer = {
  id: string;
  name: string;
  description?: string | null;
  type: OfferType;
  trigger: object;        // type-specific (see below)
  reward: object;         // discriminated by `kind`
  eligibility: { customerScope: 'ALL'|'SEGMENT'|'SPECIFIC'|'NEW_ONLY',
                 segments?: string[], customerNumbers?: string[],
                 regionIds?: string[], repIds?: string[], storeNumbers?: string[] };
  validFrom?: string | null;   // ISO
  validTo?: string | null;     // ISO
  daysOfWeek?: number[] | null; // 0=Sun … 6=Sat
  timeFrom?: string | null;     // 'HH:mm'
  timeTo?: string | null;       // 'HH:mm'
  totalRedemptionLimit?: number | null;
  perCustomerLimit?: number | null;
  priority: number;             // higher evaluated first
  stackable: boolean;
  isActive: boolean;
  redemptionCount: number;
  createdAt: string; updatedAt: string;
  status?: 'active'|'paused'|'scheduled'|'expired';   // derived, present on read
}
```

### trigger by type
| type | trigger |
|------|---------|
| `ITEM_QTY_DISCOUNT` | `{ itemNumber, minQty }` |
| `BUY_X_GET_Y_FREE` | `{ itemNumber, qty }` |
| `BASKET_THRESHOLD` | `{ itemNumbers: string[], minItemCount }` |
| `ITEM_SET_THRESHOLD` | `{ itemNumbers: string[], minTotalQty, match: 'ANY'\|'ALL' }` |
| `LOYALTY_FIRST_PURCHASE` | `{}` |

### reward (discriminated by `kind`)
```jsonc
DISCOUNT:         { "kind": "DISCOUNT", "discountType": "PERCENT"|"VALUE", "value": 10, "appliesTo": "TRIGGER_ITEM"|"SET"|"INVOICE" }
FREE_ITEM:        { "kind": "FREE_ITEM", "items": [{ "itemNumber": "WATER-330", "qty": 1 }] }
FREE_ITEM_CHOICE: { "kind": "FREE_ITEM_CHOICE", "choices": ["WATER-330","MANGO-250"], "qty": 1 }
```

### Per-type reward legality (enforced in `OffersService.validateConfig`)
| type | allowed reward |
|------|----------------|
| `ITEM_QTY_DISCOUNT` | `DISCOUNT` · `appliesTo` **TRIGGER_ITEM** |
| `BUY_X_GET_Y_FREE` | `FREE_ITEM` |
| `BASKET_THRESHOLD` | `DISCOUNT` (**INVOICE**) · or `FREE_ITEM` / `FREE_ITEM_CHOICE` |
| `ITEM_SET_THRESHOLD` | `DISCOUNT` (**SET** must be PERCENT, or **INVOICE**) · or `FREE_ITEM` / `FREE_ITEM_CHOICE` |
| `LOYALTY_FIRST_PURCHASE` | `DISCOUNT` (**INVOICE**) · or `FREE_ITEM` / `FREE_ITEM_CHOICE` |

---

## Admin endpoints (require permission `canManageOffers` for writes)

### `GET /offers`
Query: `status` (`all|active|paused|scheduled|expired`, default `all`), `type`, `search`, `page`, `limit`.
```jsonc
data = {
  items: Offer[],
  total, page, limit, pages,
  stats: { active, scheduled, expired, redemptionsThisMonth }
}
```

### `GET /offers/:id` → `data: Offer`

### `POST /offers` → `data: Offer`  *(perm `canManageOffers`)*
Body = `Offer` minus server fields (`name`, `type`, `trigger`, `reward` required; rest optional). Rejects rewards illegal for the type with `400`.

### `PATCH /offers/:id` → `data: Offer`  *(perm)*  — partial; re-validates when `type`/`trigger`/`reward` change.
### `POST /offers/:id/toggle` → `data: Offer`  *(perm)*  — flips `isActive`.
### `DELETE /offers/:id` → `204`  *(perm)*  — soft delete.

### `GET /offers/:id/redemptions`
Query: `page`, `limit`.
```jsonc
data = {
  items: [{ id, offerId, voucherNumber?, customerNumber?, discountFils, freeItems:[{itemNumber,qty}], createdAt }],
  total, page, limit, pages,
  totals: { count, discountFils }
}
```

---

## Client endpoints (any authenticated user)

### `GET /offers/active?customerNumber=&storeNumber=`
Plain **array** of currently-active offers (schedule live now), for the sale device to cache. Optional `storeNumber` narrows to offers scoped to that store. Eligibility/limits stay authoritative at `/offers/evaluate`.
```jsonc
data = Offer[]
```

### `POST /offers/evaluate`  — stateless preview (no redemption written)
```jsonc
// request
{ "customerNumber"?, "repId"?, "storeNumber"?, "at"?,        // at = ISO datetime, defaults now
  "lines": [ { "itemNumber": "COLA-330", "qty": 6 } ] }       // qty is a number

// response (data)
{
  "lines": [ { "itemNumber", "qty", "unitPriceFils", "lineDiscountFils", "lineNetFils" } ],
  "freeLines": [ { "itemNumber", "qty", "unitPriceFils", "offerId" } ],
  "invoiceDiscountFils": 0,
  "appliedOffers": [ { "offerId", "name", "type", "summary", "discountFils",
                       "freeItems": [{"itemNumber","qty"}],
                       "freeItemChoice"?: { "choices": ["WATER-330"], "qty": 1 } } ],
  "totals": { "subtotalFils", "lineDiscountFils", "invoiceDiscountFils",
              "totalDiscountFils", "taxFils", "grandTotalFils" }
}
```
`freeItemChoice` is present only for `FREE_ITEM_CHOICE` offers — the rep picks one of `choices` on the device; the chosen item is added as a normal cart line and the server re-evaluates on upload (a free line = the item at its real price with 100% line discount, net 0).

---

## Voucher integration (authoritative re-apply)
Offers are recomputed inside `VouchersService.create` for **SALE** vouchers. The client sends `appliedOfferIds: string[]` on the create DTO; the server recomputes discounts/free amounts from the cart, writes one `offer_redemptions` row per applied offer (keyed by `voucher_number`), increments `redemptionCount`, and persists `applied_offer_ids` on the voucher header. Client-sent discounts are never trusted.

## Data model
- `offers` (jsonb `trigger`/`reward`/`eligibility`; schedule, limits, `priority`, `stackable`, `is_active`, `redemption_count`).
- `offer_redemptions` (append-only ledger; indexed by `(offer_id, created_at)` and `(offer_id, customer_number)`).
- `voucher_headers.applied_offer_ids jsonb`.
Migration: `src/database/migrations/1718900000000-AddOffers.ts`. Demo offers (one per type) are seeded by `src/database/seeds/run.ts`.
