# API — Plan 15 · Offers Engine (`/api/v1/offers`)

The **offers engine** stores promotion definitions and is the **authoritative**
computer of discounts. Managers create/edit offers from the dashboard; the sale
device (and the dashboard preview) call `POST /offers/evaluate` to turn a cart
into per-line discounts, free lines and an invoice discount. When a sale is
created with `appliedOfferIds`, the engine records a **redemption** per offer and
stamps the ids onto the voucher.

Base URL: `/api/v1/offers`. All routes require `Authorization: Bearer <jwt>`.
Writes (`POST`/`PATCH`/`DELETE`, and `toggle`) require the **`canManageOffers`**
permission (ADMIN bypasses). Reads and `evaluate` are open to any authenticated
user — the sale device must be able to evaluate.

> Shared envelopes (success `{ success, data, timestamp }` + error) are in
> [`docs/api/00.5-preflight.md`](./00.5-preflight.md). Standard 400/401/403/404
> responses are auto-applied; only offer-specific cases are listed per route.

**Money:** every amount in this API is **integer fils** (1 JOD = 1000 fils), the
project's canonical unit. A DISCOUNT reward of kind `VALUE` is in fils; of kind
`PERCENT` it is whole-percent (0–100).

---

## Offer types

The `type` is a closed vocabulary; each type allows only certain rewards
(enforced on create/update — an illegal pairing returns `400`).

| Type | Trigger fields | Allowed reward |
|------|----------------|----------------|
| `ITEM_QTY_DISCOUNT` | `itemNumber`, `minQty` | `DISCOUNT` on `TRIGGER_ITEM` |
| `BUY_X_GET_Y_FREE` | `itemNumber`, `qty` | `FREE_ITEM` / `FREE_ITEM_CHOICE` |
| `BASKET_THRESHOLD` | `itemNumbers[]`, `minItemCount` | `DISCOUNT` on `INVOICE`, or free |
| `ITEM_SET_THRESHOLD` | `itemNumbers[]`, `minTotalQty`, `match` (`ANY`/`ALL`) | `DISCOUNT` on `SET` (PERCENT) / `INVOICE`, or free |
| `LOYALTY_FIRST_PURCHASE` | _none_ (auto: new customer's first purchase) | `DISCOUNT` on `INVOICE`, or free |

**Reward shapes**
- `DISCOUNT`: `{ kind:'DISCOUNT', discountType:'PERCENT'|'VALUE', value, appliesTo:'TRIGGER_ITEM'|'SET'|'INVOICE' }`
- `FREE_ITEM`: `{ kind:'FREE_ITEM', items:[{ itemNumber, qty }] }` — appended to the invoice as its own line at real price, 100% off.
- `FREE_ITEM_CHOICE`: `{ kind:'FREE_ITEM_CHOICE', choices:[itemNumber], qty }` — the rep picks at sale; `evaluate` surfaces the choice but adds no line.

**Eligibility** (`eligibility` object): `customerScope` = `ALL` / `SEGMENT`
(matches `customer.category`) / `SPECIFIC` (`customerNumbers`) / `NEW_ONLY`; plus
optional `regionIds`, `repIds`, `storeNumbers`.

**Stacking:** offers are considered by `priority` (desc, then oldest). Stackable
offers combine; the first **non-stackable** offer that applies ends the chain.

---

## `GET /api/v1/offers`

List offers, newest-priority first, with stat counts for the dashboard cards.

**Query**

| Param | Type | Notes |
|-------|------|-------|
| `page` | int | 1-based, default 1 |
| `limit` | int | default 25, max 200 |
| `search` | string | name `ILIKE` |
| `status` | enum | `all` (default) / `active` / `paused` / `scheduled` / `expired` |
| `type` | enum | one of the 5 offer types |

**Response `data`**: `{ items: Offer[], total, page, limit, pages, stats: { active, scheduled, expired, redemptionsThisMonth } }`. Each `Offer` carries a derived `status`.

---

## `POST /api/v1/offers` — `@RequirePermissions('canManageOffers')`

Create an offer.

**Request body** (`CreateOfferDto`)
```json
{
  "name": "Summer ice-tea 6+1",
  "type": "BUY_X_GET_Y_FREE",
  "trigger": { "itemNumber": "ICETEA-330", "qty": 6 },
  "reward": { "kind": "FREE_ITEM", "items": [{ "itemNumber": "WATER-500", "qty": 1 }] },
  "eligibility": { "customerScope": "ALL" },
  "validFrom": "2026-06-01T00:00:00Z",
  "validTo": "2026-08-31T23:59:59Z",
  "daysOfWeek": [0, 1, 2, 3, 4],
  "timeFrom": "08:00",
  "timeTo": "20:00",
  "totalRedemptionLimit": 500,
  "perCustomerLimit": 2,
  "priority": 10,
  "stackable": false,
  "isActive": true
}
```
- `name`, `type`, `trigger`, `reward` required; everything else optional.
- `trigger`/`reward` must be legal for `type` (see table) — otherwise `400`.

**Response** — `201`, `data: Offer` (with `status`).

**Errors**: `400` for an illegal trigger/reward combination (message names the missing/forbidden field); `403` without `canManageOffers`.

---

## `POST /api/v1/offers/evaluate`

Evaluate the active offers against a cart. **No special permission** — the sale
device calls this. Read-only (records nothing).

**Request body** (`EvaluateOffersDto`)
```json
{
  "customerNumber": "C-000123",
  "repId": "1f0c…",
  "storeNumber": "VAN-01",
  "at": "2026-06-21T10:00:00Z",
  "lines": [
    { "itemNumber": "ICETEA-330", "qty": 12 },
    { "itemNumber": "CHIPS-50", "qty": 2 }
  ]
}
```
- `lines` required (`itemNumber` + `qty` in sellable units). The rest are optional context; `customerNumber` drives eligibility + the new-customer check; `at` defaults to now (schedule/day/time).

**Response `data`** (`EvaluationResult`, all fils)
```ts
{
  lines: { itemNumber, qty, unitPriceFils, lineDiscountFils, lineNetFils }[];
  freeLines: { itemNumber, qty, unitPriceFils, offerId }[];   // 100%-off lines
  invoiceDiscountFils: number;
  appliedOffers: {
    offerId, name, type, summary, discountFils,
    freeItems: { itemNumber, qty }[],
    freeItemChoice?: { choices: string[], qty }   // rep picks at sale
  }[];
  totals: { subtotalFils, lineDiscountFils, invoiceDiscountFils, totalDiscountFils, taxFils, grandTotalFils };
}
```

---

## `GET /api/v1/offers/{id}`

**Response `data`**: the `Offer` (with `status`). `404` if unknown.

---

## `PATCH /api/v1/offers/{id}` — `@RequirePermissions('canManageOffers')`

Partial update. When `type`, `trigger` or `reward` change, the **effective**
config (existing merged with the patch) is re-validated.

**Response `data`**: the updated `Offer`. **Errors**: `400` illegal config; `404` unknown.

---

## `POST /api/v1/offers/{id}/toggle` — `@RequirePermissions('canManageOffers')`

Flip `isActive` (active ⇄ paused).

**Response `data`**: the `Offer` with the new `status`. `404` if unknown.

---

## `DELETE /api/v1/offers/{id}` — `@RequirePermissions('canManageOffers')`

Soft-delete (sets `deletedAt`; redemptions are retained).

**Response** — `204`. `404` if unknown.

---

## `GET /api/v1/offers/{id}/redemptions`

Per-offer usage report.

**Query**: `page`, `limit` (as above).

**Response `data`**: `{ items: OfferRedemption[], total, page, limit, pages, totals: { count, discountFils } }`, where each redemption is `{ id, offerId, voucherNumber, customerNumber, discountFils, freeItems, createdAt }`.

---

## Sale integration

`POST /api/v1/vouchers` accepts an optional **`appliedOfferIds: string[]`** (SALE
only). The ids are stored on `voucher_headers.applied_offer_ids`; after the sale
commits, the engine recomputes each named offer against the cart and writes a
redemption row (best-effort — a failure there never blocks the sale).

## Swagger

All endpoints render at `/docs` with Bearer auth, tagged `offers`.
