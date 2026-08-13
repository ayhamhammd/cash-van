# Spec — per-unit stock: sell one item as several units, each with its own quantity

Status: **approved, implementing** · Scope: cash-van backend (NestJS) + dashboard (Next.js) +
FlowVan app (KMP). ERP: data only, no code change.

## 1. The problem, stated exactly

A hair-care client sells each product in six colours: أحمر أخضر أزرق أسود أصفر زهري.

In the **ERP** each colour is its own `product_skus` row, and every ERP stock table is keyed
by `sku_id`. The ERP has per-colour stock and always did.

In the **cash van** those six SKUs were collapsed into one `item_cart` row plus six
`item_units` rows, and stock is aggregated **per item, in base pieces**:

```sql
-- item_balance, the only stock read model
GROUP BY ic.item_number, ic.item_name, m.store_number   -- no unit dimension
```

So 100 red + 100 blue is 200 pieces of one item, indistinguishable. A rep cannot sell 3 red
and 2 blue on one invoice: `van_stock` is unique on `(rep_id, product_id)`, the mobile cart is
keyed on `productId` alone and *overwrites* the unit when a second one is picked
(`VoucherViewModel.confirmDialog`), and the upload payload carries the Arabic display name in
`unitCode` with `unitBaseQty = 1` for every colour — nothing that tells red from blue.

**Goal:** the same item can be sold as several units on one document, each with its own
quantity, each drawing from its own stock.

## 2. The model

### 2.1 Two kinds of unit — this is the whole design

`item_units` today means one thing but is used for two:

| kind | example | what it is | stock |
|---|---|---|---|
| **packaging** | `كرتونة ×12` | a way to *enter* a quantity of the same goods | draws from the item's **base pool**, contributing `qty × 12` pieces |
| **variant** | `أحمر ×1` | a physically *different* good | owns its **own pool** |

The ERP already draws this line: a variant is a sibling `product_skus` row with
`unitMultiplier = 1`; a packaging unit is a `unit_conversions` row used on a document line and
multiplied into base pieces at posting (`purchasing/actions.ts:461`).

Cash van gets one new flag to carry the same distinction:

```
item_units.is_stock_unit BOOLEAN NOT NULL DEFAULT false
```

### 2.2 The stock pool

Stock is keyed by a **stock unit code** — the pool a movement lands in:

```
poolOf(line) = line.itemUnit?.isStockUnit ? unit.code : ''      -- '' = the item's base pool
qtyOf(line)  = qtyOfUnit × multiplier                            -- always base pieces, unchanged
```

The stock grain becomes **`(item_number, stock_unit_code, store_number)`**, which is exactly
the ERP's `(sku_id, warehouse_id)` — one cash-van pool per ERP SKU.

Quantities stay in base pieces at `numeric(14,3)`. **Nothing about the arithmetic changes** —
only the key gains a column.

### 2.3 Why `DEFAULT false` matters

Every existing `item_units` row migrates to `is_stock_unit = false`, every existing
`voucher_transactions` row to `stock_unit_code = ''`. That is a **behaviour-preserving
upgrade**: one pool per item, packaging units converting into it, exactly as today. An install
that never re-syncs never changes.

The flag flips only when ERP sync recognises a variant (§5.2) or an operator sets it in the
dashboard.

> **Why not make every unit its own pool?** A carton is not a different product. Flipping the
> tobacco client's `كرتونة ×12` to its own pool would zero the carton pool on upgrade and fail
> their next sale. Packaging and variants are genuinely different and the code must say which
> it means.

### 2.4 Identity on the wire

`unit_code` is a free-text snapshot and today the app posts the *Arabic display name* in it.
A pool key cannot rest on that. Lines gain an authoritative id:

- `voucher_transactions.item_unit_id UUID NULL` → `item_units.id` (null = base pool)
- `VoucherLineDto.itemUnitId?: string`

`unitCode` stays accepted for back-compat and is resolved server-side (§4.2); `item_unit_id`
wins when both are present.

### 2.5 ERP SKU identity

`item_units` gains `erp_sku_code TEXT NULL`, populated by sync, so an outbound sale can post
against the variant's real SKU instead of the base one.

## 3. Phase 1 — backend: the stock grain

Migration `1722600000000-PerUnitStock.ts`:

```sql
ALTER TABLE item_units
  ADD COLUMN is_stock_unit boolean NOT NULL DEFAULT false,
  ADD COLUMN erp_sku_code  text;
CREATE INDEX idx_item_units_erp_sku ON item_units (erp_sku_code) WHERE erp_sku_code IS NOT NULL;

ALTER TABLE voucher_transactions
  ADD COLUMN stock_unit_code text NOT NULL DEFAULT '',
  ADD COLUMN item_unit_id    uuid REFERENCES item_units(id) ON DELETE SET NULL;
CREATE INDEX idx_voucher_transactions_stock_unit
  ON voucher_transactions (item_number, stock_unit_code);

ALTER TABLE van_stock
  ADD COLUMN stock_unit_code text NOT NULL DEFAULT '';
ALTER TABLE van_stock DROP CONSTRAINT uq_van_stock_rep_product;
ALTER TABLE van_stock ADD CONSTRAINT uq_van_stock_rep_product_unit
  UNIQUE (rep_id, product_id, stock_unit_code);
```

`item_balance` is rebuilt with the unit dimension. **It must keep returning one row per
`(item_number, stock_number)` for callers that do not ask for a unit** — see below.

```sql
DROP VIEW item_balance;
CREATE VIEW item_balance AS
SELECT ic.item_number,
       ic.item_name,
       m.store_number                          AS stock_number,
       COALESCE(m.stock_unit_code, '')         AS stock_unit_code,
       COALESCE(SUM(m.delta), 0)::numeric(14,3) AS qty
  FROM item_cart ic
  LEFT JOIN (
      SELECT vt.item_number, vt.from_store_number AS store_number,
             vt.stock_unit_code, -vt.item_qty AS delta
        FROM voucher_transactions vt
        JOIN voucher_headers vh ON vh.voucher_number = vt.voucher_number AND vh.is_posted
       WHERE vt.from_store_number IS NOT NULL
      UNION ALL
      SELECT vt.item_number, vt.to_store_number,
             vt.stock_unit_code, vt.item_qty
        FROM voucher_transactions vt
        JOIN voucher_headers vh ON vh.voucher_number = vt.voucher_number AND vh.is_posted
       WHERE vt.to_store_number IS NOT NULL
  ) m ON m.item_number = ic.item_number
 GROUP BY ic.item_number, ic.item_name, m.store_number, COALESCE(m.stock_unit_code, '');
```

Adding a column to the GROUP BY splits existing rows — but only where
`stock_unit_code <> ''`, and after the backfill nothing is. Existing readers
(`van-stock.service.ts`, `reports.service.ts`, `mobile.service.ts`) keep working unchanged on
day one; each is then updated deliberately.

A second view for the per-item roll-up, so callers that legitimately want "all colours" do not
have to know the grain:

```sql
CREATE VIEW item_balance_total AS
SELECT item_number, item_name, stock_number, SUM(qty)::numeric(14,3) AS qty
  FROM item_balance GROUP BY item_number, item_name, stock_number;
```

**Entities:** `ItemUnit` (+`isStockUnit`, `erpSkuCode`), `VoucherTransaction`
(+`stockUnitCode`, `itemUnitId`), `VanStock` (+`stockUnitCode`), `ItemBalanceView`
(+`stockUnitCode`), new `ItemBalanceTotalView`.

## 4. Phase 2 — backend: the write path

### 4.1 Resolve the pool once, use it everywhere

In `VouchersService.create`, first pass, alongside `unitFactor`:

```ts
const iu = await this.resolveItemUnit(em, line);          // by itemUnitId, else unitCode, else null
const stockUnitCode = iu?.isStockUnit ? iu.unit!.code : '';
const unitFactor = iu ? Math.max(1, iu.qty) : (line.unitBaseQty ?? 1);
```

`unitFactor` now comes from the resolved row (`item_units.qty`), not from a number the client
sent — the client's `unitBaseQty` is only a fallback for old builds. This also settles the
long-standing split where `/products` reads `item_units.qty` and `/mobile` reads
`units.base_qty`: **`item_units.qty` is the factor. `units.base_qty` is a default for new
attachments and nothing else.**

### 4.2 `resolveItemUnit`

1. `line.itemUnitId` → `item_units.id` (404 if it is not this item's).
2. else `line.unitCode` matched, in order, against `item_units.barcode`, `units.code`,
   `units.name_ar` — the last because installed APKs post the Arabic display name.
3. else null → base pool.

An ambiguous name match on an item with two same-named units is a `400`, not a guess.

### 4.3 Everything keyed by the pool

| site | today | becomes |
|---|---|---|
| availability check (`vouchers.service.ts:744-761`) | `${itemNumber}\0${store}` | `${itemNumber}\0${stockUnitCode}\0${store}` |
| `stockBalance()` | `WHERE item_number=$1 AND stock_number=$2` | `+ AND stock_unit_code=$3` |
| error text | `Not enough stock of X in store S` | `+ ` (unit `أحمر`)` when the pool is not base |
| `applyLineToVan()` | `findOne({repId, productId})` | `+ stockUnitCode` |
| `fulfill()` reservation release | same | same |
| line persist | — | `stockUnitCode`, `itemUnitId` |

Two lines of the same item in different units on one voucher are **two independent pools** and
must not be aggregated. Two lines of the same item in the *same* unit still aggregate for the
check, as today.

### 4.4 Read endpoints

- `GET /reps/:repId/van-stock` (`van-stock.service.ts`) — the feed the app actually uses.
  Returns one row **per (product, stock unit)**: `+ stockUnitCode`, `+ unitName`,
  `+ itemUnitId`. Rows with `stockUnitCode = ''` keep today's shape, so an old APK reading
  `productId`/`quantity` still sees the base pool.
- `GET /products` (`products.service.ts:attachUnits`) — `ProductUnitView` gains
  `itemUnitId: string`, `isStockUnit: boolean`. `conversionQty` keeps reading `iu.qty`.
  Also call `attachUnits` from `findOne()`, which omits it today.
- `GET /items/balance/list` — expose `stockUnitCode` and an optional `stockUnitCode` filter.
- `mobile.service.ts` — `getItem().itemUnits[].unitQty` stops being
  `floor(itemBalance / factor)` over the shared pool and becomes
  `floor(poolBalance(unit) / factor)`. `getVanStock()` emits `quantity` per unit.

### 4.5 Reports

`reports.service.ts` groups sales by `item_number`. Add `stock_unit_code` / `unit_name` to the
item-sales and stock-balance reports so a per-colour figure is readable. Roll-ups that mean
"the whole item" read `item_balance_total`.

## 5. Phase 3 — backend: ERP sync

### 5.1 Inbound movements — `mirrorMovement`

`GET /api/v1/stock-movements` already returns `skuCode` per movement; the identity is in the
feed and is discarded on arrival. Resolve it to a **pool**, not just an item:

```ts
const target = await this.resolveStockTarget(mv.skuCode);
// { itemNumber, itemUnitId | null, stockUnitCode }  — via item_units.erp_sku_code,
// falling back to item_cart.item_number and erp_id_map for the base SKU
```

and write the mirrored line with `stockUnitCode` / `itemUnitId`. A SKU that resolves to
nothing still throws per-row and is skipped per-row (the existing behaviour).

### 5.2 Catalog — `upsertProductItem`

On every upsert of a non-base SKU:

```ts
iu.erpSkuCode  = s.sku;
iu.isStockUnit = mult === 1;   // a same-size sibling SKU is the ERP's variant idiom;
                               // a pack (mult > 1) stays a packaging unit
```

Writing this on **update**, not only insert, is what migrates the existing client: one re-sync
flips their 66 colour units to their own pools and leaves any `×12` pack alone.

`ensureUnit` keeps creating a `units` row whose `code` is the Arabic label. That is how the
colour units already exist in production, and `UnitsService.assertBaseRule` — which rejects a
non-`PCE` unit with `baseQty = 1` — must be relaxed to allow it, or the dashboard can never
author or correct a variant. Replace the rule with: `PCE` must be 1; anything else is free.

### 5.3 Outbound — `erp-outbox.service.ts`

`buildSale`/returns/transfers send `skuCode: l.itemNumber` — always the base SKU. They become:

```ts
skuCode: l.itemUnit?.erpSkuCode ?? l.itemNumber
```

so a red sale posts against the red SKU. `unitPrice` keeps dividing by `unitBaseQty` (the ERP
wants a per-base-piece price); for a variant that divisor is 1.

Without this the ERP's own per-colour stock diverges from the van's on the very first sale.

## 6. Phase 4 — dashboard

- **`ItemUnitsSection`** (`ProductDrawer.tsx`) — a "مخزون مستقل / own stock" switch per unit
  row, bound to `isStockUnit`; show the unit's current stock; refuse detach when the pool is
  non-zero. Show `erpSkuCode` read-only when present.
- **`StockBalancesView` / `StockBalancesReport`** — unit column, unit filter, row key
  `${itemNumber}-${stockUnitCode}-${stockNumber}` (today's key collides across variants).
- **`NewVoucherView`** — `availByItem` becomes `availBy(itemNumber, stockUnitCode)`; the
  over-stock check compares against the chosen unit's pool; the unit `<select>` writes
  `itemUnitId` onto the line; repeated `(item, unit)` pairs aggregate, different units do not.
- **`StockTransferView`** — same, plus "get all van stock" emits one line per pool.
- **`ItemPickerDialog` / `ItemPickerModal`** — select an `(item, unit)` pair and show that
  pair's availability.
- **`VoucherView` / `VoucherReceipt` / `TransferReceipt`** — the unit is already displayed;
  make it unambiguous (name + code) and fix `TransferReceipt`'s "total pieces" footer, which
  sums `itemQty` across mixed units.
- **Dashboard low-stock, reports best-items, approvals** — carry the unit label through.
- `endpoints.ts` — any new query param.

## 7. Phase 5 — FlowVan app

### 7.1 Room v16 → v17

`product_units` gains, all with literal defaults so `@AutoMigration` can add them:

```kotlin
@ColumnInfo(name = "van_stock",  defaultValue = "0") val vanStock: Int = 0,
@ColumnInfo(name = "code",       defaultValue = "''") val code: String = "",
@ColumnInfo(name = "is_base",    defaultValue = "0") val isBase: Boolean = false,
@ColumnInfo(name = "is_stock_unit", defaultValue = "0") val isStockUnit: Boolean = false,
```

`FlowVanDatabase` → `version = 17` + `AutoMigration(from = 16, to = 17)`, and the exported
`17.json` committed (`exportSchema = true` will fail the build without it).

`products.vanStock` stays, and now means **the base pool only**.

### 7.2 Stable unit identity

`RefreshCatalogUseCase` synthesises `id = barcode.ifBlank { "$productId:$code:$conversionQty" }`
— which collapses every blank-barcode colour of an item onto one id. Use the server's
`itemUnitId` (new in `ProductUnitDto`), which is a real uuid, and keep the old expression only
as a fallback. Stop discarding `code` and `isBase`.

`productUnits.deleteAll()` on every refresh must become a merge that preserves `vanStock`, or
stock is wiped on every catalog pull (which happens on login and on home refresh).

### 7.3 Stock overlay

`VanStockItemDto` gains `stockUnitCode`, `itemUnitId`, `unitName`. `refreshVanStock()` writes
base-pool rows to `products.setStock` and variant rows to `productUnits.setStock`.

### 7.4 The cart — the actual blocker

`CartLine` gains `unitId: String = ""` (`""` = base). **Every cart mutation keys on
`(productId, unitId)`, not `productId`**: `confirmDialog`, `stepItem`, `changeQty`,
`RemoveItem` in all three carts — `VoucherViewModel`, `ReturnVoucherViewModel`,
`RequestVoucherViewModel`. Today `confirmDialog` finds by `productId` and overwrites `unit`,
which is precisely why 3 red + 2 blue is impossible.

`AddItemBottomSheet.onConfirm` must pass the `ProductUnit` (or its id), not just the name; the
sheet's `remember(product.id)` state keys become `remember(product.id, selectedUnit.id)`;
unit re-resolution by `name ==` (three sites) becomes by id.

Availability in the sheet:

```kotlin
val availableBase = if (unit.isStockUnit) unit.vanStock else product.vanStock
val requestedBase = qty * unit.conversionQty
```

`VoucherCart`'s `items(products, key = { it.id })` becomes a composite key — two lines of one
item under one key is a `LazyColumn` crash.

### 7.5 Local stock movement

The four `products.adjustStock(productId, ±stockQty.toInt())` sites
(`CreateSaleVoucherUseCase`, `CreateReturnVoucherUseCase`, `DiscountApprovalUseCases`,
`ReturnApprovalUseCases`) route to `productUnits.adjustStock(unitId, …)` when the line's unit
is a stock unit.

While here, fix the pre-existing asymmetry in `CreateSaleVoucherUseCase`: the guard compares
`line.qty` (unit count) to `vanStock` (base pieces) while the decrement uses `line.stockQty`
(qty × conversion) — selling 5 cartons of 12 checks against 5 and deducts 60.

### 7.6 Upload

`LocalSyncMappers.toVoucherRequest` sends `itemUnitId = line.unitId` (new field on
`VoucherTxn`) and keeps `unitCode`/`unitName` as they are for old servers. `InvoiceLine` gains
`unitId: String = ""` — it must have a serialization default, because unsynced invoices already
on devices are deserialized from `linesJson` after the update.

### 7.7 Offers

`EvaluateOffers*` fingerprints the cart as `sku to qty`. Splitting one item into several
variant lines changes the cardinality. Aggregate by `sku` **before** evaluating so an offer
threshold of 5 still sees 3 red + 2 blue as 5.

## 8. Phase 6 — seed 100 per unit in the ERP

The ERP has no stock-voucher document type; `bulkAdjustStockAction`
(`dashboard/inventory/actions.ts:386`) is the path that already produced the existing colour
movements, and it writes `item_stock`, `product_skus.stock_level` and a `stock_movements` row.

**Do not use `POST /api/v1/stock-adjustments`** — it hardcodes `source: "van"`, and the
outbound feed the cash van reads filters that source out for loop prevention. Anything seeded
through it is invisible to the van.

Seed **+100 to all 77 SKUs** (11 base + 66 colour) in warehouse `MAIN`, then
`POST /erp-sync/now` and verify 77 pools of 100.

## 9. Acceptance

1. `item_balance` returns one row per `(item, unit, store)`; an item with six colour units in
   one store returns seven rows (six colours + base).
2. A voucher with two lines of the same item in different units posts, and each pool moves by
   its own quantity.
3. Selling more red than the red pool holds is refused **even when the item total is
   sufficient** — the error names the unit.
4. A packaging unit (`×12`, `is_stock_unit = false`) still converts into the base pool: a sale
   of 3 removes 36 base pieces. **Unchanged from today.**
5. A rep on the phone adds 3 red and 2 blue of one item to one invoice and sees two lines.
6. That invoice reaches the ERP as two lines against the red and blue SKUs.
7. An ERP stock movement on the blue SKU lands in the blue pool.
8. An install that upgrades and never re-syncs behaves exactly as before.
9. An old APK posting `unitCode` with an Arabic name still posts, resolved by §4.2.

## 10. Known limits

- A variant that also has packaging (`carton of red`) is not representable: a unit has one
  pool and one factor. The ERP cannot express it either (`product_skus.unit_id` is one row).
- History cannot be re-attributed. Every line ever posted moved the base pool; variant pools
  start at zero and are filled by the first movement that names them.
- `item_units.barcode` is globally unique across all items, and ERP sync falls back to
  `barcode || sku` — two products cannot share a variant barcode.
- `item_units.sale_price` is `numeric(14,2)` while every DTO formats 3 decimals; the third
  decimal is already silently truncated on save. Not fixed here.
