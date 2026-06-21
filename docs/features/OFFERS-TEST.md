# Offers Engine — Tester Guide (backend)

How to exercise the offers API end-to-end. Works against local (`http://127.0.0.1:3000`) or the Render deployment (`https://cashvan-api-9qrt.onrender.com`). All paths are under `/api/v1`. Money is **fils** (1 JOD = 1000 fils).

## 0. Prerequisites
- Run migrations + seed (Render does this automatically on boot via `start:deploy`; locally: `npm run migration:run && npm run seed`). The seed creates **5 demo offers**, one per type, plus the drinks catalog.
- Get a token: `POST /api/v1/auth/login` with the admin (`userNumber: admin`, `password: admin1234`). Use it as `Authorization: Bearer <token>` on every call below.

Set up a shell variable:
```bash
BASE=https://cashvan-api-9qrt.onrender.com/api/v1
TOKEN=<paste-jwt>
auth=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
```

## 1. List the seeded offers
```bash
curl -s "${auth[@]}" "$BASE/offers?status=active" | jq '.data.items[] | {name, type, status}'
curl -s "${auth[@]}" "$BASE/offers" | jq '.data.stats'   # { active, scheduled, expired, redemptionsThisMonth }
```
**Expect:** 5 active offers; `stats.active` ≥ 5.

## 2. Evaluate a cart (the core preview) — one case per type

> `/offers/evaluate` writes nothing. `qty` is a number. Discounts come back in fils.

**T1 — ITEM_QTY_DISCOUNT** (10× ICETEA-330 → 10% off that line):
```bash
curl -s "${auth[@]}" -X POST "$BASE/offers/evaluate" \
  -d '{"lines":[{"itemNumber":"ICETEA-330","qty":10}]}' | jq '.data'
```
Expect: `lines[0].lineDiscountFils = 500` (10× 500 fils = 5000 × 10% = 500); `appliedOffers[0].type = "ITEM_QTY_DISCOUNT"`.
Now try `qty:9` → **no** discount (`appliedOffers` empty).

**T2 — BUY_X_GET_Y_FREE** (6× COLA-330 → 1 WATER-330 free):
```bash
curl -s "${auth[@]}" -X POST "$BASE/offers/evaluate" \
  -d '{"lines":[{"itemNumber":"COLA-330","qty":6}]}' | jq '.data.freeLines, .data.appliedOffers'
```
Expect: one `freeLines` entry `{ itemNumber: "WATER-330", qty: 1, unitPriceFils: 150, offerId }`.

**T3 — BASKET_THRESHOLD → FREE_ITEM_CHOICE** (12 items from {COLA,PEPSI,SPRITE} → choose a free item):
```bash
curl -s "${auth[@]}" -X POST "$BASE/offers/evaluate" \
  -d '{"lines":[{"itemNumber":"COLA-330","qty":6},{"itemNumber":"PEPSI-330","qty":6}]}' | jq '.data.appliedOffers'
```
Expect: an applied offer with `freeItemChoice: { choices: ["WATER-330","MANGO-250"], qty: 1 }` (no auto free line — the rep picks).

**T4 — ITEM_SET_THRESHOLD** (≥20 water units across the set → 8% off water lines, match ANY):
```bash
curl -s "${auth[@]}" -X POST "$BASE/offers/evaluate" \
  -d '{"lines":[{"itemNumber":"WATER-330","qty":20}]}' | jq '.data.lines, .data.appliedOffers'
```
Expect: `lines[0].lineDiscountFils = 240` (20× 150 = 3000 × 8%). With `qty:19` → no discount.

**T5 — LOYALTY_FIRST_PURCHASE** (new customer's first sale → 5% invoice):
```bash
curl -s "${auth[@]}" -X POST "$BASE/offers/evaluate" \
  -d '{"customerNumber":"C-1002","lines":[{"itemNumber":"COLA-1L","qty":4}]}' | jq '.data.invoiceDiscountFils, .data.appliedOffers'
```
Expect: `invoiceDiscountFils > 0` only if `C-1002` has **no prior posted SALE**. After posting a sale for that customer, re-evaluating returns no loyalty discount.

## 3. CRUD
```bash
# create (illegal reward for the type is rejected with 400)
curl -s "${auth[@]}" -X POST "$BASE/offers" -d '{
  "name":"Test 5+1","type":"BUY_X_GET_Y_FREE",
  "trigger":{"itemNumber":"PEPSI-330","qty":5},
  "reward":{"kind":"FREE_ITEM","items":[{"itemNumber":"WATER-330","qty":1}]}
}' | jq '.data | {id, status}'

# negative: a DISCOUNT reward on BUY_X_GET_Y_FREE → 400
curl -s -o /dev/null -w "%{http_code}\n" "${auth[@]}" -X POST "$BASE/offers" -d '{
  "name":"bad","type":"BUY_X_GET_Y_FREE","trigger":{"itemNumber":"PEPSI-330","qty":5},
  "reward":{"kind":"DISCOUNT","discountType":"PERCENT","value":10,"appliesTo":"TRIGGER_ITEM"}}'
# → 400

ID=<id-from-create>
curl -s "${auth[@]}" -X POST "$BASE/offers/$ID/toggle" | jq '.data.isActive'   # flips
curl -s "${auth[@]}" -X PATCH "$BASE/offers/$ID" -d '{"priority":50}' | jq '.data.priority'
curl -s -o /dev/null -w "%{http_code}\n" "${auth[@]}" -X DELETE "$BASE/offers/$ID"  # → 204
```

## 4. End-to-end at sale time (server-authoritative)
Offers apply automatically when a **SALE** is created — you do **not** send `appliedOfferIds`; the server re-evaluates the cart and bakes in discounts + free lines + redemptions. Create a SALE with a trigger cart (e.g. 6× COLA-330 to fire the BUY_X_GET_Y_FREE offer) via the vouchers API, then inspect the result:
```bash
# the created voucher should carry the offer effects:
curl -s "${auth[@]}" "$BASE/vouchers/$VOUCHER_ID" | jq '{appliedOfferIds, transactions: [.data.transactions[] | {itemNumber, discountPercentage, discountValue}]}'
```
Expect: `appliedOfferIds` is non-empty; a **WATER-330 free line** is present with `discountPercentage = 100` (net 0); and any line/invoice discounts are baked in — matching what `/offers/evaluate` previewed for the same cart.

Then the redemption ledger:
```bash
curl -s "${auth[@]}" "$BASE/offers/$OFFER_ID/redemptions" | jq '{items: .data.items, totals: .data.totals}'
```
Expect: one row per applied offer with `discountFils` and `freeItems`, plus a `totals` summary. Re-creating the same `voucherNumber` is rejected (409), so redemptions never double-count.

## 5. Active-offers cache (mobile)
```bash
curl -s "${auth[@]}" "$BASE/offers/active?storeNumber=VAN-01" | jq 'length, .data | length'
```
Expect: a plain array (`data`) of active offers; passing a `storeNumber` excludes offers scoped to *other* stores only.

## 6. Swagger
With `SWAGGER_ENABLED=true`, browse **`/docs`** → tag **offers** for live, try-it-out docs of every endpoint above.

---
### Pass criteria
- Each of the 5 types evaluates as described; sub-threshold carts grant nothing.
- Illegal reward/type combos are rejected with `400` and a precise message.
- Free lines come back at the item's real price (net 0 after the 100% line discount is applied at sale).
- Redemptions are written once per applied offer when a SALE posts; re-syncing the same voucher number does not duplicate.
