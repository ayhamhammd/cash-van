# SPEC — ERP Customer Price Lists → FlowVan (cash-van) + Dashboard

Bring the ERP's **customer-specific pricing** into the FlowVan cash-van system so a
salesman sells each customer at their **contracted price** (offline, on the van), and
managers see those prices in the dashboard. The **ERP is the master**; FlowVan mirrors
and applies.

Status: **proposal**. Complements [erp integration](../../.claude) and the ERP-sync
service. Money is in **fils** on the FlowVan side throughout.

---

## 1. Goal / user story

- A distributor sets, per customer, a **price list** (e.g. WHOLESALE) and/or **special
  contract prices** for specific products in the ERP.
- When a rep opens that customer on the van and adds an item, the line **pre-fills the
  contracted price**, not the generic list price — even with no signal.
- If the ERP marks the customer as *not* allowed manual edits, the rep **cannot change**
  the price.
- The dashboard shows each customer's assigned price list + effective overrides
  (read-only — editing stays in the ERP).

---

## 2. Part A — The ERP model (source of truth)

Drizzle schema in `ERP/src/db/schema.ts`; resolver in `ERP/src/lib/pricing-engine/`.

| Table | Purpose | Key columns |
|---|---|---|
| `price_lists` | A named list (org-scoped) | `code`, `name`, `is_default`, `is_active` |
| `price_list_items` | Lines of a list, per SKU, with qty tiers | `price_list_id`, `sku_id`, `min_qty`, `max_qty`, `price`, `start_date`, `end_date` |
| `customer_prices` | Per-customer contract price per SKU | `customer_id`, `sku_id`, `min_qty`, `max_qty`, `special_price`, `priority`, dates |
| `promotions` | %/fixed discounts, scoped all/sku/category | `discount_type`, `discount_value`, `scope_type`, dates |
| `customers.price_list_id` | Assigns a list to a customer | + `allow_manual_price_edit` |

**Resolution order** (ERP `resolver.ts`, per customer+sku+qty+date):
1. `customer_prices` (lowest `priority` wins) →
2. customer's `price_list` item (most specific qty tier) →
3. active `promotion` applied on top →
4. SKU `selling_price` default.

**Money:** integer **thousandths** = **fils** (9500 = 9.500 JOD). The ERP API accepts and
returns **major decimals** (`price: 9.5`), converting with `Math.round(x*1000)` internally.

### ERP API FlowVan will consume (v1, API-key + scopes)

| Method / path | Scope | Use |
|---|---|---|
| `GET /api/v1/prices?customerCode=&skuCode=&barcode=&page=` | `products:read` | **Resolved** effective price per SKU for a customer + `priceSource` (`CUSTOMER_PRICE` \| `PRICE_LIST` \| `DEFAULT_PRICE`). **Primary endpoint.** |
| `GET /api/v1/customers` | `customers:read` | Customer rows incl. `priceListId`, `priceListName` (+ `allowManualPriceEdit`). |
| `GET /api/v1/price-lists` / `/{id}` | `price_lists:read` | Lists + their items with qty tiers (Phase 2). |
| webhook `price_list.created` (+ future `*.updated`) | — | Real-time invalidation. |

> The ERP already resolves the 4-tier price. FlowVan should **store the answer**
> (`/prices`) rather than re-implement the engine — see Phase 1.

---

## 3. Part B — FlowVan today (what we extend)

- **Products:** `ItemCart.price` (fils, base unit) + one `ItemUnit` per pack
  (`salePrice` JOD major, `qty` pieces, unique `barcode`). Synced from ERP `GET
  /api/v1/skus` by `erp-sync.service.ts → pullItems()`, which already does
  `price = Math.round(sku.sellingPrice * 1000)`.
- **Per-customer pricing today:** only `PriceRule` (product×**segment**, discount%/fixed,
  qty, dates) resolved by `PricingService.quote(productId, qty, customerId?)` via the
  customer's **AI segment** — there is **no per-customer-id contract price**. Plus the
  `offers` engine (order/line discounts, orthogonal).
- **How a sale is priced:** the **mobile app sends `unitPrice`** (from its cached
  catalog) on the voucher line; the backend stores it as-is on promote. The web
  dashboard instead calls `PricingService.quote()`.
- **ERP inbound seam:** `erp-sync.service.ts` — 5-min scheduled pull + Integration-Hub
  webhook fast-path + manual `syncNow()`. `pullCustomers()` currently syncs credit/TIN
  but **no pricing**.

---

## 4. Part C — Integration design

### C0. Money units — no conversion mismatch
ERP thousandths ≡ FlowVan fils. `/prices` returns major decimals → store
`Math.round(price * 1000)` (identical to `pullItems`). ✅

### C1. New FlowVan storage — `customer_prices` cache
A dedicated table (ERP-owned mirror; never edited locally):

```
customer_prices
  id            uuid pk
  customer_id   uuid  → customers.id            (indexed)
  item_id       uuid  → item_cart.id            (resolved product)
  item_unit_id  uuid  → item_units.id  null     (specific pack; from ERP skuCode)
  erp_sku       text                            (ERP sku code, for mapping/debug)
  unit_price    integer                         (fils)
  price_source  text                            (CUSTOMER_PRICE | PRICE_LIST)
  min_qty       integer default 1               (Phase 2 tiers; Phase 1 = 1)
  max_qty       integer null
  valid_from    date null
  valid_to      date null
  erp_price_list_id text null
  synced_at     timestamptz
  unique (customer_id, erp_sku, min_qty)
```

Add to `customers`: `erp_price_list_id text`, `erp_price_list_name text`,
`allow_manual_price_edit boolean default true`.

> Do **not** overload `PriceRule.customerSegment` with `"customer:{id}"`. Keep
> ERP-sourced contract prices in their own table so local AI `PriceRule`s and `offers`
> stay independent.

### C2. Sync path — extend `erp-sync.service.ts`
- **`pullCustomers()`**: also persist `priceListId` → `erp_price_list_id`,
  `priceListName`, `allowManualPriceEdit`.
- **New `pullCustomerPrices()`**: for each active customer (scoped to reps' customers),
  `GET /api/v1/prices?customerCode={code}`, **drop rows where `priceSource =
  DEFAULT_PRICE`** (only store real overrides), map `skuCode → item_unit → item`, upsert
  `customer_prices` (`unit_price = round(price*1000)`). Prune rows absent from the latest
  pull.
- **Scheduling:** join the 5-min pull + `refreshAll()`; on Hub webhook
  `price_list.*` / `customer.*` → `triggerWebhookSync('customer-prices')`. (If the ERP
  doesn't yet emit price webhooks, the 5-min pull covers it — see open decisions.)
- **Respect the ERP toggle:** when the app runs *without* ERP, skip entirely; base
  prices + local `PriceRule`/offers apply as today.

### C3. Mobile app (offline) — apply the contracted price
- Ship overrides to the device: `GET /mobile/customer-prices?salesmanCode=` (or fold
  into the existing customer/catalog sync bundle) → cache per customer.
- **Line resolution** when a rep adds `(customer, itemUnit, qty)`:
  1. look up `customer_prices` by `(customerId, erp_sku|item_unit)` valid for today/qty →
     use `unit_price`;
  2. else fall back to the unit's base `salePrice`/`ItemCart.price` (today's behavior).
- **`allowManualPriceEdit = false`** → lock the price field (rep sees it, can't edit);
  `true` → pre-fill but editable. The app still **sends** the final `unitPrice` (no
  backend contract change).
- Show a small "contract price" chip on the line so the rep knows why the price differs.

### C4. Dashboard — surface it (read-only, ERP-master)
- **Customer profile** (`features/customers/CustomerProfile.tsx`): a new **"Price list"**
  tab — shows `erp_price_list_name`, `allowManualPriceEdit`, and a table of effective
  overrides (product, unit, price via `formatJOD`, source, validity). Read-only with a
  "Managed in ERP" note + link.
- **Customer form**: display the assigned list (read-only) instead of editing.
- Optional (Phase 2): a `features/pricing/` admin view listing all overrides.

### C5. Server-side `PricingService.quote()` — honor contracts for web vouchers
Before the segment `PriceRule` lookup, check `customer_prices` for
`(customerId, productId/unit)`. Precedence to mirror the ERP:
**customer contract price → segment PriceRule → base**, then `offers` on top. Return the
same `PriceQuote` shape with a `priceSource` field.

---

## 5. Phasing

| Phase | Scope | Notes |
|---|---|---|
| **1 — Resolved overrides (recommended first)** | `pullCustomerPrices()` via `/prices`, `customer_prices` cache, app pre-fill + lock, customer-profile tab, `quote()` extension | Leverages ERP's resolver; small data (overrides only, `priceSource ≠ DEFAULT`); **no qty tiers**. |
| **2 — Mirror lists + tiers** | Also mirror `price_lists`/`price_list_items`, resolve qty breaks + promotions locally | Scales (a list is shared by many customers); needs a local resolver. |

---

## 6. Field mapping (ERP → FlowVan)

| ERP | FlowVan | Transform |
|---|---|---|
| `/prices.skuCode` / `barcode` | `item_units.barcode`/sku → `item_id` + `item_unit_id` | existing sku→item map from `pullItems` |
| `/prices.price` (major) | `customer_prices.unit_price` (fils) | `Math.round(price*1000)` |
| `/prices.priceSource` | `customer_prices.price_source` | `DEFAULT_PRICE` rows dropped |
| `customers.code` | `customers.code` | match key |
| `customers.priceListId` / `priceListName` | `customers.erp_price_list_id` / `erp_price_list_name` | copy |
| `customers.allowManualPriceEdit` | `customers.allow_manual_price_edit` | copy |

---

## 7. Open decisions

1. **Qty tiers offline** — `/prices` returns one effective price per SKU (base tier). Do
   we need van-side quantity breaks now? If yes → Phase 2 (mirror `price_list_items`), or
   have the ERP accept `&qty=` on `/prices`.
2. **Real-time invalidation** — ERP emits only `price_list.created`. Add
   `price_list.updated` / `customer_price.changed` webhooks, or accept ≤5-min staleness.
3. **Scope of the pull** — all customers vs only each rep's assigned customers (data size
   on the device). Recommend rep-scoped.
4. **Precedence vs local rules/offers** — confirm contract price outranks AI `PriceRule`s;
   confirm `offers` still stack on top of the contracted price.
5. **`allowManualPriceEdit` enforcement** — app-side lock only, or also a backend guard
   that rejects a promoted line whose `unitPrice` ≠ the synced contract price when edits
   are disallowed (server-side integrity).

---

## 8. Acceptance scenarios

- Customer with a WHOLESALE list → rep adds product X → line shows the wholesale price,
  offline. ✅
- Customer with a `customer_prices` special on X (priority 1) → that price wins over the
  list. ✅
- `allowManualPriceEdit = false` → price field locked in the app; a tampered
  `unitPrice` is rejected server-side (if open-decision #5 = yes). ✅
- Product with **no** override → base catalog price, exactly as today. ✅
- ERP disabled (work-without-ERP) → no sync, base prices, no regressions. ✅
- Dashboard customer profile shows the list name + effective overrides, read-only. ✅
```
