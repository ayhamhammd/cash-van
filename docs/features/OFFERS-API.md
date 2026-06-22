# Offers Engine — API Reference (backend)

> Status: **implemented** · Module: `src/modules/offers` · Swagger: `/docs` (tag **offers**) when `SWAGGER_ENABLED=true`.
> Authoritative contract the dashboard and mobile app are built against. Money is **integer fils** (1 JOD = 1000 fils).

All routes are under the global prefix `/api/v1`, require a Bearer JWT, and return the standard envelope:

```jsonc
{ "success": true, "data": <payload>, "timestamp": "2026-06-21T..." }
```

The offer model is a closed type vocabulary. Current types:

## Types

```ts
OfferType = 'PAYMENT_METHOD_DISCOUNT' | 'ITEM_QTY_REWARD'

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

### `PAYMENT_METHOD_DISCOUNT`
A **per-line percentage** discount applied to every invoice line, gated by the order's payment method and optional minimums. Static keeps the percent fixed; dynamic scales it with the order's item count.

**trigger**
```jsonc
{ "paymentCondition": "CASH" | "CREDIT",   // CASH = any non-CREDIT payment; CREDIT = CREDIT only
  "minOrderTotal": 10000,                    // optional, fils — min order subtotal to qualify
  "minItemCount": 6 }                        // optional — min total item count (Σ qty)
```

**reward** (`kind: 'LINE_PERCENT_DISCOUNT'`)
```jsonc
{ "kind": "LINE_PERCENT_DISCOUNT",
  "basePercent": 10,             // 0–100, applied to every line
  "mode": "STATIC" | "DYNAMIC",
  "multiplier": 0.5,             // DYNAMIC only
  "itemsPerStep": 6,             // DYNAMIC only
  "maxPercent": 25 }             // DYNAMIC only, cap 0–100
```
Dynamic rate: `effectivePct = basePercent × (1 + multiplier × floor(itemCount ÷ itemsPerStep))`, capped at `maxPercent` (and 100). Amount-off (VALUE) rewards are **out of scope** in this iteration.

**Legality** (enforced in `OffersService.validateConfig`): `paymentCondition ∈ {CASH,CREDIT}`; `basePercent` 0–100; `mode` STATIC/DYNAMIC; DYNAMIC requires `multiplier > 0` and `itemsPerStep ≥ 1`, and `maxPercent` (if set) between `basePercent` and 100.

### `ITEM_QTY_REWARD`
Buy a quantity of selected item(s) → a **gift** or a **per-item discount**. The threshold is the **combined** quantity of the trigger items in the cart.

**trigger**
```jsonc
{ "itemNumbers": ["COLA-330", "PEPSI-330"] }   // the selected items; threshold = their combined qty
```

**reward** — one of:
```jsonc
// (a) GIFT — rep picks free items from a pool; quantity by static tiers (highest reached wins)
{ "kind": "GIFT",
  "giftItems": ["WATER-330", "MANGO-250"],          // pool the rep chooses from
  "tiers": [ { "minQty": 10, "freeQty": 1 }, { "minQty": 20, "freeQty": 2 } ] }

// (b) ITEM_PERCENT_DISCOUNT — % off the SELECTED items' lines once combined qty ≥ minQty
{ "kind": "ITEM_PERCENT_DISCOUNT",
  "minQty": 12, "basePercent": 10,
  "mode": "STATIC" | "DYNAMIC", "multiplier": 0.5, "itemsPerStep": 6, "maxPercent": 25 }
```
Dynamic rate (same formula as above; `qty` = combined selected-item qty). For a GIFT offer, evaluate surfaces `appliedOffers[].freeItemChoice = { choices: giftItems, qty: freeQty }`; the rep's picks come back as `freeLines` once `chosenFreeItems` is sent (see evaluate).

**Legality**: `itemNumbers` non-empty; GIFT requires `giftItems` non-empty + ≥1 tier (`minQty`/`freeQty` ≥ 1); ITEM_PERCENT_DISCOUNT requires `minQty` ≥ 1 + the percentage fields above.

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
{ "customerNumber"?, "repId"?, "storeNumber"?,
  "paymentMethod"?: "CASH"|"CHEQUE"|"TRANSFER"|"CARD"|"CREDIT",  // drives PAYMENT_METHOD_DISCOUNT
  "chosenFreeItems"?: ["WATER-330"],                             // ITEM_QTY_REWARD gift picks → freeLines
  "at"?,                                                          // ISO datetime, defaults now
  "lines": [ { "itemNumber": "COLA-330", "qty": 6 } ] }           // qty is a number

// response (data)
{
  "lines": [ { "itemNumber", "qty", "unitPriceFils", "lineDiscountFils", "lineNetFils" } ],
  "freeLines": [],                 // empty for current types
  "invoiceDiscountFils": 0,        // 0 for current types (discounts are per-line)
  "appliedOffers": [ { "offerId", "name", "type", "summary", "discountFils", "freeItems": [] } ],
  "totals": { "subtotalFils", "lineDiscountFils", "invoiceDiscountFils",
              "totalDiscountFils", "taxFils", "grandTotalFils" }
}
```
For `PAYMENT_METHOD_DISCOUNT` the discount is applied **per line** — read it from `lines[].lineDiscountFils` (`lineNetFils` is the post-discount, pre-tax net). `freeLines`/`invoiceDiscountFils`/`freeItemChoice` belong to future types and are empty here.

---

## Voucher integration (server-authoritative)
Offers are applied **inside `VouchersService.create` for SALE vouchers** — the server is the single source of truth. On create it:
1. Re-evaluates active offers against the cart (same engine as `/offers/evaluate`), reading the **payment method from `payments[0].paymentType`** (defaults CASH) and the **rep's gift picks from `chosenFreeItems`** on the create DTO.
2. **Applies** the result to the voucher: per-line discounts → each line's `discountValue`; ITEM_QTY_REWARD **gift lines are appended** (the chosen pool items at real price with `discountPercentage = 100`, net 0, stock still moves). The server validates picks against the offer's pool/count.
3. Writes one `offer_redemptions` row per applied offer (keyed by `voucher_number`), increments `redemptionCount`, and stamps `applied_offer_ids` on the header.

Clients (mobile/dashboard) therefore **do not need to send `appliedOfferIds`** — any client-sent value is ignored and overwritten by the server's own evaluation, so the posted voucher always matches what `/offers/evaluate` previews. Offer discounts are system-granted and bypass the salesman manual-discount approval gate. The whole step is best-effort: if evaluation fails the sale still posts (just without offers). Non-SALE vouchers (RETURN/ORDER/…) are never offer-adjusted.

## Data model
- `offers` (jsonb `trigger`/`reward`/`eligibility`; schedule, limits, `priority`, `stackable`, `is_active`, `redemption_count`).
- `offer_redemptions` (append-only ledger; indexed by `(offer_id, created_at)` and `(offer_id, customer_number)`).
- `voucher_headers.applied_offer_ids jsonb`.
Migration: `src/database/migrations/1718900000000-AddOffers.ts` (generic jsonb columns — new types need no migration). Demo offers (payment-method + item-quantity gift/discount) are seeded by `src/database/seeds/run.ts`. `voucher.chosenFreeItems` (create DTO) carries the rep's gift picks.
