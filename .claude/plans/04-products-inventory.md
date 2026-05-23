# Plan 04 — Products, Categories, Van Stock, Pricing

Spec ref: Part 3.4 (adapted for single-tenant deployment)
Depends on: [01 — Auth/Reps/Settings](./01-tenants-auth-reps.md), [03 — Customers](./03-customers.md)

## Goal

Evolve the existing `item_cart` into a spec-compliant **products** model with categories, **per-rep van stock**, and a **pricing rules engine**.

> **No `tenant_id` / no RLS** (single-tenant). `UNIQUE (tenant_id, sku)` becomes `UNIQUE (sku)`.
> **Money = INTEGER fils.** Backfill `price = ROUND(item_switch.sale_price * 1000)`.
> **FK target:** new tables FK to `item_cart(id)` (UUID PK), not `item_number`.
> **Van stock** is current-state (upsert per rep+product); the "snapshots" endpoint returns current state (time-travel history is future work).

## Existing → Target Mapping

The existing tables are `item_cart`, `item_switch`, `expiry_items`. They are referenced by `voucher_transactions`. We will **extend** rather than rename so legacy FKs survive.

| Existing | Action |
|---|---|
| `item_cart` | extend with new columns; conceptually = `products` |
| `item_switch` | keep (unit conversions) |
| `expiry_items` | keep |

## New columns on `item_cart` (a.k.a. products)
```
tenant_id UUID NOT NULL FK→tenants,
sku TEXT,                    -- backfill from item_number; add UNIQUE (tenant_id, sku)
name_ar TEXT NOT NULL,       -- backfill from item_name
name_en TEXT,
category_id UUID FK→product_categories,
unit TEXT DEFAULT 'carton',
unit_of_measure TEXT DEFAULT 'PCE',  -- UN/CEFACT code for JoFotara line `invoicedQuantity.unitCode`
price INTEGER NOT NULL DEFAULT 0,    -- minor units (fils); backfill from item_switch.sale_price (primary unit)
cost INTEGER,
image_url TEXT,              -- alias to existing photo_url
is_active BOOLEAN DEFAULT TRUE,
reorder_qty INTEGER DEFAULT 0,
-- Tax classification (drives invoice line tax calc + JoFotara classifiedTaxCategory)
tax_type TEXT NOT NULL DEFAULT 'TAXABLE',    -- TAXABLE | INCLUSIVE | EXEMPT
tax_category TEXT NOT NULL DEFAULT 'S',      -- S (standard 16%) | Z (zero-rated) | E (exempt)
tax_rate NUMERIC(5,4) NOT NULL DEFAULT 0.16  -- backfill from existing tax_percentage / 100
```
Note: existing `tax_percentage NUMERIC(5,2)` stays for legacy callers; `tax_rate` is the canonical column going forward, kept in sync via a trigger or app-side write.

## New tables

### `product_categories`
```
id UUID PK, tenant_id UUID, name_ar TEXT, name_en TEXT,
parent_id UUID FK→product_categories, sort_order INT
```

### `van_stock`
```
id BIGSERIAL PK, rep_id UUID FK→reps, product_id UUID FK→item_cart,
quantity INT, loaded_at TIMESTAMPTZ, snapshot_at TIMESTAMPTZ,
UNIQUE (rep_id, product_id)
```

### `price_rules`
```
id UUID PK, tenant_id UUID, product_id UUID FK→item_cart NULL,
customer_segment TEXT NULL, min_qty INT DEFAULT 1,
discount_pct REAL DEFAULT 0, fixed_price INTEGER NULL,
valid_from DATE, valid_to DATE
```

## Checklist

### Migration
- [ ] `<ts>-ExtendItemsAndAddPricingVanStock.ts`
- [ ] `ALTER TABLE item_cart ADD COLUMN tenant_id` → backfill → SET NOT NULL
- [ ] Add `sku, name_ar, name_en, category_id, unit, unit_of_measure, price, cost, image_url, is_active, reorder_qty, tax_type, tax_category, tax_rate`
- [ ] Add check constraints: `tax_type IN ('TAXABLE','INCLUSIVE','EXEMPT')`, `tax_category IN ('S','Z','E')`
- [ ] Backfill: `tax_rate = tax_percentage / 100`; default `tax_category='S'` when rate=0.16, else 'E' if rate=0 and item is exempt-flagged
- [ ] Backfill: `sku ← item_number`, `name_ar ← item_name`, `price` from primary `item_switch.sale_price`
- [ ] `CREATE UNIQUE INDEX uq_item_cart_tenant_sku ON item_cart (tenant_id, sku)`
- [ ] `CREATE INDEX ON item_cart (tenant_id, category_id, is_active)`
- [ ] `CREATE TABLE product_categories` + index `(tenant_id, parent_id, sort_order)`
- [ ] `CREATE TABLE van_stock` + indexes `(rep_id)`, `(product_id)`
- [ ] `CREATE TABLE price_rules` + indexes `(tenant_id, product_id)`, `(valid_from, valid_to)`
- [ ] Enable RLS on all three new tables

### Entities
- [ ] Extend `src/modules/items/entities/item-cart.entity.ts` (add fields above)
- [ ] `src/modules/products/entities/product-category.entity.ts`
- [ ] `src/modules/products/entities/van-stock.entity.ts`
- [ ] `src/modules/products/entities/price-rule.entity.ts`
- [ ] Decision: keep `items.module.ts` as-is for legacy callers, add new `products.module.ts` re-exporting the same entity with richer service methods

### Module
- [ ] `src/modules/products/products.module.ts` + `products.service.ts` + `products.controller.ts`
- [ ] Inject existing `ItemBalanceService` (read-only view) to expose `qty_on_hand`
- [ ] `PricingService` — computes effective price = max(applicable price_rules) for (product, customer_segment, qty)
- [ ] `VanStockService` — load/unload, snapshot history

### DTOs
- [ ] `CreateProductDto`, `UpdateProductDto`
- [ ] `CreateProductCategoryDto`, `UpdateProductCategoryDto`
- [ ] `VanStockSnapshotDto`
- [ ] `CreatePriceRuleDto`, `UpdatePriceRuleDto`
- [ ] `QuotePriceDto` — `{ product_id, customer_id?, qty }` returns `{ unit_price, discount_pct, final_unit_price }`

### Endpoints — Products
- [ ] `GET /api/v1/products` with filters `?category_id=&q=&is_active=&include_stock=true`
- [ ] `GET /api/v1/products/:id`
- [ ] `POST /api/v1/products`
- [ ] `PATCH /api/v1/products/:id`
- [ ] `DELETE /api/v1/products/:id` (soft)
- [ ] `POST /api/v1/products/:id/quote` — pricing engine

### Endpoints — Categories
- [ ] `GET /api/v1/product-categories` (tree)
- [ ] `POST /api/v1/product-categories`
- [ ] `PATCH /api/v1/product-categories/:id`

### Endpoints — Van Stock
- [ ] `GET /api/v1/reps/:repId/van-stock` — current quantities
- [ ] `POST /api/v1/reps/:repId/van-stock/load` — `{ items: [{product_id, quantity}] }`
- [ ] `POST /api/v1/reps/:repId/van-stock/return` — unload back to warehouse
- [ ] `GET /api/v1/van-stock/snapshots?date=` — historical snapshot

### Endpoints — Price Rules
- [ ] `GET /api/v1/price-rules`
- [ ] `POST /api/v1/price-rules`
- [ ] `PATCH /api/v1/price-rules/:id`
- [ ] `DELETE /api/v1/price-rules/:id`

### Acceptance
- [ ] Existing `voucher_transactions` and `item_switch` still resolve (legacy FKs unbroken)
- [ ] Create product → list product → quote price for (product, qty=10) returns discounted price when a matching rule exists
- [ ] Load van stock for rep A, then `GET /reps/A/van-stock` shows correct quantities
- [ ] Category tree endpoint returns nested structure
