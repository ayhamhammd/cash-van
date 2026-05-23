# Test plan — Plan 04 · Products, Categories, Van Stock, Pricing

Manual end-to-end verification through Docker. Use `curl.exe` for Arabic input.

Prereqs:

```bash
docker compose up -d db app
docker compose run --rm app npm run migration:run
docker compose run --rm app npm run seed
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r .data.accessToken)
```

---

## 1. Migration applied

```bash
docker compose run --rm app npm run migration:show | grep ExtendItems
docker compose exec db psql -U cashvan -d cashvan -c "\d van_stock"
docker compose exec db psql -U cashvan -d cashvan -c "\d price_rules"
docker compose exec db psql -U cashvan -d cashvan -c \
  "SELECT column_name FROM information_schema.columns WHERE table_name='item_cart' AND column_name IN ('sku','price','tax_rate','name_ar');"
```

- [ ] `[X] ExtendItemsAndAddPricingVanStock...`
- [ ] `van_stock` and `price_rules` tables exist (each with a `version` column)
- [ ] `item_cart` has `sku, price, tax_rate, name_ar`

---

## 2. Legacy items still work

```bash
curl -s http://localhost:3000/api/v1/items -H "Authorization: Bearer $TOKEN" | jq .success
```

- [ ] `true` — the existing items module is unbroken

---

## 3. Category create + tree

```bash
CAT=$(curl -s -X POST http://localhost:3000/api/v1/product-categories \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"nameAr":"مشروبات","nameEn":"Beverages","sortOrder":1}' | jq -r .data.id)

curl -s http://localhost:3000/api/v1/product-categories -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] Category created (has `version: 1`)
- [ ] Tree returns the category with a `children: []` array

Create a child to verify nesting:

```bash
curl -s -X POST http://localhost:3000/api/v1/product-categories \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"nameAr\":\"عصائر\",\"parentId\":\"$CAT\"}" | jq .data.id
curl -s http://localhost:3000/api/v1/product-categories -H "Authorization: Bearer $TOKEN" | jq '.data[0].children | length'
```

- [ ] Parent's `children` array has length ≥ 1

---

## 4. Product create (price in fils)

```bash
PID=$(curl -s -X POST http://localhost:3000/api/v1/products \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"itemNumber\":\"P001\",\"barcode\":\"6291000000001\",\"name\":\"Cola 330ml\",\"categoryId\":\"$CAT\",\"price\":12500,\"taxRate\":0.16}" | jq -r .data.id)
echo $PID
```

- [ ] HTTP 201
- [ ] `data.price === 12500`, `data.sku === "P001"` (defaulted from itemNumber)
- [ ] Duplicate `itemNumber` → 409

---

## 5. Quote — no rule

```bash
curl -s -X POST "http://localhost:3000/api/v1/products/$PID/quote" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"qty":10}' | jq
```

- [ ] `listUnitPrice === 12500`, `appliedRuleId === null`
- [ ] `finalUnitPrice === 12500`, `lineTotal === 125000`

---

## 6. Quote — with rule

```bash
curl -s -X POST http://localhost:3000/api/v1/price-rules \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"productId\":\"$PID\",\"minQty\":10,\"discountPct\":10}" | jq .data.id

curl -s -X POST "http://localhost:3000/api/v1/products/$PID/quote" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"qty":10}' | jq
```

- [ ] qty=10 → `discountPct: 10`, `finalUnitPrice: 11250`, `lineTotal: 112500`, `appliedRuleId` set

```bash
curl -s -X POST "http://localhost:3000/api/v1/products/$PID/quote" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"qty":5}' | jq
```

- [ ] qty=5 (below minQty) → no discount, `finalUnitPrice: 12500`

---

## 7. Van stock load / return

```bash
REP=$(curl -s -X POST http://localhost:3000/api/v1/reps \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"nameAr":"Van Rep"}' | jq -r .data.id)

curl -s -X POST "http://localhost:3000/api/v1/reps/$REP/van-stock/load" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"productId\":\"$PID\",\"quantity\":100}]}" | jq

curl -s "http://localhost:3000/api/v1/reps/$REP/van-stock" -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] After load: `quantity: 100`, `status: "sufficient"`

```bash
curl -s -X POST "http://localhost:3000/api/v1/reps/$REP/van-stock/return" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"productId\":\"$PID\",\"quantity\":30}]}" | jq
curl -s "http://localhost:3000/api/v1/reps/$REP/van-stock" -H "Authorization: Bearer $TOKEN" | jq '.data[0].quantity'
```

- [ ] After return: `quantity: 70`
- [ ] Returning more than on hand clamps at 0 (never negative)

---

## 8. Segment pricing (optional, needs an AI profile)

Give a customer a segment, attach a segment rule, quote with that customer:

```bash
# assumes a customer + customer_ai_profile row with segment='champions' exists
curl -s -X POST http://localhost:3000/api/v1/price-rules \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"productId\":\"$PID\",\"customerSegment\":\"champions\",\"minQty\":1,\"discountPct\":20}" | jq .data.id

curl -s -X POST "http://localhost:3000/api/v1/products/$PID/quote" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"qty\":1,\"customerId\":\"<CHAMPION_CUSTOMER_ID>\"}" | jq
```

- [ ] `segment: "champions"`, the 20% rule applies (`finalUnitPrice: 10000`)
- [ ] Same quote without `customerId` → segment rule does NOT apply

---

## 9. Roles guard

- [ ] `POST /products` as `viewer` role → 403
- [ ] `DELETE /products/:id` as `manager` → 403 (admin-only)
- [ ] `POST /price-rules` as `manager` → allowed

---

## 10. Unit tests

```bash
docker compose run --rm --no-deps app npm test
```

- [ ] `Tests: 26 passed, 26 total`

---

## 11. Swagger

Open `http://localhost:3000/docs`:

- [ ] Tags `products`, `product-categories`, `van-stock`, `price-rules` present
- [ ] Quote endpoint documents the response shape

---

## Done

All green → plan 04 verified. Plan 05 (Routes) next.
