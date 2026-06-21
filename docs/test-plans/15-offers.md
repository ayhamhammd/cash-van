# Test plan — Plan 15 · Offers Engine

Verifies the offers CRUD, the per-type config guards, the `/offers/evaluate`
discount engine for all 5 types, status/toggle, and sale-time redemption
recording. Runs against the Docker stack.

## 0. Prereqs

```bash
docker compose up -d db app
docker compose run --rm app npm run migration:run   # creates offers, offer_redemptions, voucher_headers.applied_offer_ids
B=http://localhost:3000/api/v1
TOKEN=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r .data.accessToken)
A="Authorization: Bearer $TOKEN"

# Pick two real items + a customer from your seed, and note the items' fils prices:
curl -s -H "$A" "$B/items?limit=5"     | jq '.data.items[] | {itemNumber, price}'
curl -s -H "$A" "$B/customers?limit=5" | jq '.data.items[] | {customerNumber, category}'
# Substitute below:
ITEM_A=ICETEA-330        # price (fils) → PRICE_A
ITEM_B=WATER-500         # price (fils) → PRICE_B
CUST=C-000123
```
- [ ] Migration runs clean; `\d offers` and `\d offer_redemptions` exist; `voucher_headers` has `applied_offer_ids`.
- [ ] Login returns a token.

---

## 1. Create one offer per type

```bash
# ITEM_QTY_DISCOUNT — 10% off item A when buying ≥ 3
OID_QTY=$(curl -s -X POST $B/offers -H "$A" -H 'Content-Type: application/json' -d "{
  \"name\":\"A 3+ → 10%\",\"type\":\"ITEM_QTY_DISCOUNT\",
  \"trigger\":{\"itemNumber\":\"$ITEM_A\",\"minQty\":3},
  \"reward\":{\"kind\":\"DISCOUNT\",\"discountType\":\"PERCENT\",\"value\":10,\"appliesTo\":\"TRIGGER_ITEM\"}}" | jq -r .data.id)

# BUY_X_GET_Y_FREE — buy 6 of A, get 1 B free
OID_FREE=$(curl -s -X POST $B/offers -H "$A" -H 'Content-Type: application/json' -d "{
  \"name\":\"6A → 1B free\",\"type\":\"BUY_X_GET_Y_FREE\",
  \"trigger\":{\"itemNumber\":\"$ITEM_A\",\"qty\":6},
  \"reward\":{\"kind\":\"FREE_ITEM\",\"items\":[{\"itemNumber\":\"$ITEM_B\",\"qty\":1}]}}" | jq -r .data.id)

# BASKET_THRESHOLD — 5+ items from {A,B} → 1.000 JOD off invoice
OID_BASKET=$(curl -s -X POST $B/offers -H "$A" -H 'Content-Type: application/json' -d "{
  \"name\":\"Basket 5 → 1JOD\",\"type\":\"BASKET_THRESHOLD\",
  \"trigger\":{\"itemNumbers\":[\"$ITEM_A\",\"$ITEM_B\"],\"minItemCount\":5},
  \"reward\":{\"kind\":\"DISCOUNT\",\"discountType\":\"VALUE\",\"value\":1000,\"appliesTo\":\"INVOICE\"}}" | jq -r .data.id)

# LOYALTY_FIRST_PURCHASE — new customer, 5% off invoice
OID_LOYAL=$(curl -s -X POST $B/offers -H "$A" -H 'Content-Type: application/json' -d "{
  \"name\":\"New customer 5%\",\"type\":\"LOYALTY_FIRST_PURCHASE\",\"trigger\":{},
  \"reward\":{\"kind\":\"DISCOUNT\",\"discountType\":\"PERCENT\",\"value\":5,\"appliesTo\":\"INVOICE\"},
  \"eligibility\":{\"customerScope\":\"NEW_ONLY\"}}" | jq -r .data.id)

echo "$OID_QTY $OID_FREE $OID_BASKET $OID_LOYAL"
```
- [ ] Each returns `201` with an `id` and a derived `status` of `active`.
- [ ] `GET $B/offers | jq .data.stats` shows `active >= 4`.

---

## 2. Config guards (per-type legality)

```bash
# Illegal: ITEM_QTY_DISCOUNT with a FREE_ITEM reward → 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/offers -H "$A" -H 'Content-Type: application/json' -d "{
  \"name\":\"bad\",\"type\":\"ITEM_QTY_DISCOUNT\",\"trigger\":{\"itemNumber\":\"$ITEM_A\",\"minQty\":3},
  \"reward\":{\"kind\":\"FREE_ITEM\",\"items\":[{\"itemNumber\":\"$ITEM_B\",\"qty\":1}]}}"

# Illegal: SET discount with VALUE (must be PERCENT) → 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/offers -H "$A" -H 'Content-Type: application/json' -d "{
  \"name\":\"bad2\",\"type\":\"ITEM_SET_THRESHOLD\",
  \"trigger\":{\"itemNumbers\":[\"$ITEM_A\"],\"minTotalQty\":3,\"match\":\"ANY\"},
  \"reward\":{\"kind\":\"DISCOUNT\",\"discountType\":\"VALUE\",\"value\":500,\"appliesTo\":\"SET\"}}"
```
- [ ] Both return `400` with a message naming the offending field.
- [ ] As a non-admin user **without** `canManageOffers`, `POST $B/offers` returns `403`.

---

## 3. Evaluate (the engine)

```bash
# ITEM_QTY_DISCOUNT: A×5 → 10% off the A line
curl -s -X POST $B/offers/evaluate -H "$A" -H 'Content-Type: application/json' \
  -d "{\"lines\":[{\"itemNumber\":\"$ITEM_A\",\"qty\":5}]}" | jq '.data | {lines, totals, appliedOffers}'

# BUY_X_GET_Y_FREE: A×12 → 2× B free (multiples)
curl -s -X POST $B/offers/evaluate -H "$A" -H 'Content-Type: application/json' \
  -d "{\"lines\":[{\"itemNumber\":\"$ITEM_A\",\"qty\":12}]}" | jq '.data.freeLines'

# BASKET_THRESHOLD: A×3 + B×3 → 1000 fils off invoice
curl -s -X POST $B/offers/evaluate -H "$A" -H 'Content-Type: application/json' \
  -d "{\"lines\":[{\"itemNumber\":\"$ITEM_A\",\"qty\":3},{\"itemNumber\":\"$ITEM_B\",\"qty\":3}]}" \
  | jq '.data | {invoiceDiscountFils, totals}'
```
- [ ] Qty-discount: `lines[0].lineDiscountFils` = 10% of `5 × PRICE_A`; `totals.grandTotalFils` = subtotal − that.
- [ ] Buy-X: `freeLines` has one entry, `itemNumber=$ITEM_B`, `qty=2`, `unitPriceFils=PRICE_B`; grand total unchanged by the free line.
- [ ] Basket: `invoiceDiscountFils=1000`; `totals.grandTotalFils` = subtotal − 1000.
- [ ] Loyalty: evaluate with `"customerNumber":"$CUST"` for a customer with **no** prior SALE → `appliedOffers` includes the loyalty offer; for a customer **with** a prior SALE → it does not.

---

## 4. Stacking, schedule & status

```bash
curl -s -X POST $B/offers/$OID_QTY/toggle -H "$A" | jq '.data.status'   # → "paused"
curl -s "$B/offers?status=paused" -H "$A" | jq '.data.items[].id'
curl -s -X POST $B/offers/$OID_QTY/toggle -H "$A" | jq '.data.status'   # → "active"
```
- [ ] Toggle flips `status` paused⇄active and the `status` filter reflects it.
- [ ] An offer with a future `validFrom` lists as `scheduled`; a past `validTo` as `expired`.
- [ ] Create a **non-stackable** higher-`priority` qty offer on `$ITEM_A`; evaluate `A×10` → only that one offer appears in `appliedOffers` (the chain stops).

---

## 5. Redemption recording via a sale

```bash
# Create a SALE voucher that applied the basket offer (adjust line fields to your CreateVoucherDto).
curl -s -X POST $B/vouchers -H "$A" -H 'Content-Type: application/json' -d "{
  \"transKind\":\"SALE\",\"userCode\":\"admin\",\"customerNumber\":\"$CUST\",
  \"appliedOfferIds\":[\"$OID_BASKET\"],
  \"transactions\":[
    {\"itemNumber\":\"$ITEM_A\",\"itemName\":\"A\",\"itemQty\":\"3\",\"unitPrice\":\"1.000\"},
    {\"itemNumber\":\"$ITEM_B\",\"itemName\":\"B\",\"itemQty\":\"3\",\"unitPrice\":\"0.500\"}
  ]}" | jq '.data | {voucherNumber, appliedOfferIds}'

curl -s "$B/offers/$OID_BASKET/redemptions" -H "$A" | jq '.data | {total, totals, items}'
```
- [ ] The voucher response echoes `appliedOfferIds: ["$OID_BASKET"]`.
- [ ] `redemptions` shows `total >= 1`; the row has the `voucherNumber`, `customerNumber=$CUST`, and a non-zero `discountFils`.
- [ ] `GET $B/offers/$OID_BASKET | jq .data.redemptionCount` increased.
- [ ] A sale with a **bogus** offer id still succeeds (best-effort hook never blocks the sale); no redemption row is written for it.

---

## 6. Delete (soft)

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE $B/offers/$OID_LOYAL -H "$A"   # → 204
curl -s -o /dev/null -w "%{http_code}\n" $B/offers/$OID_LOYAL -H "$A"             # → 404
```
- [ ] Delete returns `204`; subsequent `GET` returns `404`; existing redemptions are retained.

---

## 7. Unit coverage

```bash
docker compose run --rm app npx jest src/modules/offers/offers-engine.spec.ts
```
- [ ] The engine suite passes (qty-discount, buy-X-get-Y, basket, stacking).

## Done

Green means: each type's config is guarded on write, `evaluate` produces the
correct fils discounts/free lines for all 5 types, status/toggle behave, and a
sale stamps + records redemptions without ever being blocked by the hook.
