# Offers Engine — Backend Spec (cash-van-dashboard)

> Status: **DRAFT / design** · Owner: backend · Consumers: dashboard (admin CRUD), FlowVan mobile (apply at sale)
> Sibling specs: dashboard → `cash-van-dashboard-frontend/docs/OFFERS.md`, mobile → `FlowVan/docs/OFFERS.md`

The **single source of truth** for promotions. The backend stores offer definitions, decides
which offers apply to a draft voucher, and **authoritatively recomputes** discounts and free
items at voucher-create time — never trusting client-sent discounts (same principle as tax:
*tax/price/discount are derived server-side*).

---

## 1. Glossary

| Term | Meaning |
|------|---------|
| **Offer** | A promotion definition created by a manager. |
| **Trigger** | The condition that must be met by the draft voucher (items/quantities/customer). |
| **Reward** | What the offer grants: a discount and/or free item(s). |
| **Redemption** | One application of an offer to one posted voucher (for limits + reporting). |
| **Free line** | A reward item added to the invoice **as its own line at its real price with a 100% line discount** (net = 0). |
| **Draft voucher** | The in-progress cart sent for evaluation before posting. |

---

## 2. Offer types

All five map to one schema (`trigger` + `reward`). `appliesTo` scopes a discount to the trigger
item, a defined set, or the whole invoice.

| # | Key | Manager describes it as | Trigger | Allowed reward(s) |
|---|-----|--------------------------|---------|-------------------|
| 1 | `ITEM_QTY_DISCOUNT` | Discount on a specific qty of a particular item | item A reaches `minQty` | `DISCOUNT` on the **trigger item** |
| 2 | `BUY_X_GET_Y_FREE` | Buy item in a qty → add a manager-chosen free item | item A reaches `minQty` | `FREE_ITEM` (fixed item B × M) |
| 3 | `BASKET_THRESHOLD` | When N items from a set are bought → discount on total **or** a free item from a list | `≥ minItemCount` items from `setItemNumbers` | `DISCOUNT` (invoice/set) **or** `FREE_ITEM_CHOICE` |
| 4 | `ITEM_SET_THRESHOLD` | Manager picks items X,Y,Z; when one or all reach a qty → discount / free item / set-discount | `setItemNumbers` reach `minTotalQty` (`match: ANY` per-item, or `ALL` combined) | `DISCOUNT` (invoice/set) **or** `FREE_ITEM` |
| 5 | `LOYALTY_FIRST_PURCHASE` | New customer's first purchase → invoice discount or free item | customer is new **and** has zero prior posted sales | `DISCOUNT` (invoice) **or** `FREE_ITEM` |

### Universal free-item rule
Whenever a reward adds a free item it is appended as a **separate `voucher_transactions` line**:
`unitPrice = item's normal price`, `discountPercentage = 100` ⇒ net 0. The line is flagged
(`offerId`, `isFree = true`) for traceability, stock still moves, and tax is computed on the
(zero) net per the active tax policy.

---

## 3. Data model

### `offers`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `name_ar`, `name_en` | text | bilingual |
| `description` | text? | |
| `type` | enum | the 5 keys above |
| `is_active` | bool | default false |
| `priority` | int | higher = evaluated first (conflict/stacking order) |
| `stackable` | bool | may combine with other offers on the same voucher |
| `valid_from`, `valid_to` | timestamptz? | open-ended when null |
| `days_of_week` | int[]? | 0=Sun..6=Sat; null = any day |
| `time_from`, `time_to` | text? | `HH:mm`; null = all day |
| `eligibility` | jsonb | see below |
| `limits` | jsonb | `{ totalRedemptions?, perCustomer? }` |
| `trigger` | jsonb | type-specific (see §4) |
| `reward` | jsonb | type-specific (see §4) |
| `created_at`/`updated_at`/`deleted_at` | timestamptz | soft-delete |

`eligibility` shape:
```jsonc
{
  "customerScope": "ALL | SEGMENT | SPECIFIC | NEW",
  "segments": ["CHAMPIONS"],            // when SEGMENT
  "customerNumbers": ["CUST-000003"],    // when SPECIFIC
  "stores": ["102"],                     // optional store/warehouse scope
  "regionIds": [],                        // optional
  "repIds": []                            // optional
}
```

### `offer_redemptions`
Append-only ledger for usage limits + reporting.
| Column | Type |
|--------|------|
| `id` | uuid PK |
| `offer_id` | uuid FK |
| `voucher_number` | text |
| `customer_number` | text? |
| `rep_id` | uuid? |
| `discount_value` | numeric | total discount this offer granted on the voucher |
| `free_items` | jsonb | `[{ itemNumber, qty }]` |
| `created_at` | timestamptz |

> Index `offer_redemptions(offer_id)`, `(customer_number, offer_id)` for limit checks.

---

## 4. Trigger & reward config per type

```jsonc
// trigger
T1: { "itemNumber": "ICETEA-330", "minQty": 10 }
T2: { "itemNumber": "ICETEA-330", "minQty": 6 }
T3: { "setItemNumbers": ["A","B","C"], "minItemCount": 12 }      // count of qualifying items
T4: { "setItemNumbers": ["X","Y","Z"], "minTotalQty": 20, "match": "ANY|ALL" }
T5: { "firstPurchaseOnly": true }

// reward (exactly one shape)
DISCOUNT:          { "kind": "DISCOUNT", "discountType": "PERCENT|VALUE", "value": 10, "appliesTo": "TRIGGER_ITEM|SET|INVOICE" }
FREE_ITEM:         { "kind": "FREE_ITEM", "items": [{ "itemNumber": "WATER-500", "qty": 1 }] }
FREE_ITEM_CHOICE:  { "kind": "FREE_ITEM_CHOICE", "choices": ["WATER-500","JUICE-250"], "qty": 1 }
```

`match`: `ANY` = any single selected item's qty reaches the threshold; `ALL` = the combined qty
of all selected items reaches it. `FREE_ITEM_CHOICE` requires the client to pick one of `choices`
(passed back at evaluate/create time as `chosenFreeItem`).

---

## 5. Evaluation engine

`OffersService.evaluate(draft): OfferEvaluation` is the core. Pure given DB offers + draft.

**Input (draft):** `{ customerNumber, repId, store, inDate, lines: [{ itemNumber, itemQty, unitPrice }], chosenFreeItems?: { offerId: itemNumber } }`

**Algorithm:**
1. Load active offers where `is_active` and now ∈ [`valid_from`,`valid_to`] and day/time window matches.
2. Filter by eligibility (customer scope/segment/specific/new, store/region/rep).
3. Enforce limits (`totalRedemptions` from ledger, `perCustomer` from ledger by customer).
4. Sort by `priority` desc; for each, test its `trigger` against the draft lines.
5. For each matched offer compute its reward:
   - `DISCOUNT/TRIGGER_ITEM` → add a discount to the trigger item's qualifying qty.
   - `DISCOUNT/SET` → distribute discount across the set's lines.
   - `DISCOUNT/INVOICE` → header-level discount.
   - `FREE_ITEM` / `FREE_ITEM_CHOICE` → emit a **free line** (see §2 rule).
6. **Stacking:** non-stackable offers are mutually exclusive — keep the highest-value applicable one. Stackable offers apply together. Never discount the same line below 0.
7. Return the resolved adjustments + a human-readable `appliedOffers` summary.

**Output (`OfferEvaluation`):**
```jsonc
{
  "lines": [ { "itemNumber", "discountPercentage", "discountValue", "offerId" } ],
  "freeLines": [ { "itemNumber", "itemQty", "unitPrice", "discountPercentage": 100, "offerId" } ],
  "invoiceDiscountValue": 0,
  "appliedOffers": [ { "offerId", "nameAr", "nameEn", "discount", "freeItems": [] } ],
  "choicesRequired": [ { "offerId", "choices": ["WATER-500","JUICE-250"] } ]
}
```

---

## 6. Endpoints

### Admin (roles: admin, manager)
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/offers` | list (filters: `type`, `isActive`, `q`) |
| `GET` | `/offers/:id` | one |
| `POST` | `/offers` | create |
| `PATCH` | `/offers/:id` | edit (validate trigger/reward vs type) |
| `POST` | `/offers/:id/toggle` | activate/pause |
| `DELETE` | `/offers/:id` | soft-delete |
| `GET` | `/offers/:id/redemptions` | usage + reporting |

### Clients (rep/admin)
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/offers/active?customerNumber=&store=&date=` | offers the rep may surface (for sync/cache) |
| `POST` | `/offers/evaluate` | evaluate a draft cart → returns `OfferEvaluation` |

> `/offers/evaluate` is **stateless** (no redemption written). Redemptions are written only when
> the voucher actually posts.

---

## 7. Integration with voucher create

Offers are applied **inside `VouchersService.create`**, after tax resolution, before totals:

1. Build a draft from the incoming `CreateVoucherDto` (SALE only by default; configurable per type).
2. Call `evaluate`. Apply returned line/invoice discounts, **append free lines**.
3. Recompute totals (existing pipeline) so `netTotal` reflects offers.
4. On success, write one `offer_redemptions` row per applied offer (with `voucher_number`).
5. Persist applied offer ids on the header (`applied_offer_ids jsonb`) for audit/print.

**Trust model:** the client may *preview* via `/offers/evaluate` and send `chosenFreeItems`, but
the server **re-evaluates and overrides** any client discount. A client-claimed offer that no
longer qualifies is silently dropped (and surfaced in the response so the UI can re-render).

`DiscountDirect`/approval gates: offers are system-granted and **bypass** the salesman discount
approval gate (they are not manual discounts).

---

## 8. Edge cases & rules

- **First-purchase (T5):** "new" = no prior **posted** SALE for that `customerNumber`. Evaluate against the ledger/vouchers atomically to avoid double-grant on rapid re-sync.
- **Free item out of stock:** still add the free line (stock can go negative per existing policy) but flag `lowStock` in the response.
- **Returns:** offers do **not** apply to RETURN/ORDER unless a type explicitly opts in. A return that references a sale with offers must not re-grant them.
- **Idempotency:** re-syncing the same voucher (same `clientRef`/number) must not write duplicate redemptions — key redemptions by `voucher_number`.
- **Rounding:** money in fils where applicable; never push a line net below 0.
- **Time window:** evaluated in store/server local time (mind the pg `date`/timezone gotcha used elsewhere).

---

## 9. Migration plan

1. Migration: `offers`, `offer_redemptions`, header columns `applied_offer_ids jsonb`, line columns `offer_id uuid?`, `is_free bool default false`.
2. `OffersModule` (service + controller + entities), wired into `VouchersService` (inject `OffersService`).
3. Seed a couple of demo offers per type for QA.

## 10. Test matrix (acceptance)

- T1: 10× item A @ 10% → line discount only on A; 9× A → no discount.
- T2: 6× A → free B×1 line at price with 100% discount; net of B = 0.
- T3: 12 items from set → invoice discount **or** prompt free-item choice; choice posts as free line.
- T4 `ANY`: X reaches 20 alone → reward; `ALL`: X+Y+Z combined reach 20 → reward.
- T5: brand-new customer's first sale → discount/free item; second sale → nothing.
- Stacking: non-stackable picks highest value; stackable combine; no negative nets.
- Limits: `perCustomer`/`total` enforced from ledger; re-sync writes no duplicate.
