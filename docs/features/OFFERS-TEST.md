# Offers Engine — Tester Guide (backend)

How to exercise the offers API end-to-end. Works against local (`http://127.0.0.1:3000`) or the Render deployment (`https://cashvan-api-9qrt.onrender.com`). All paths are under `/api/v1`. Money is **fils** (1 JOD = 1000 fils).

## 0. Prerequisites
- Run migrations + seed (Render does this automatically on boot via `start:deploy`; locally: `npm run migration:run && npm run seed`). The seed creates **2 demo payment-method offers** plus the drinks catalog:
  - **Cash · 5% off each line** — `paymentCondition: CASH`, `minOrderTotal: 10000` (10 JOD), static 5%.
  - **Credit · dynamic** — `paymentCondition: CREDIT`, `minItemCount: 6`, base 10% × 0.5 per 6 items, cap 25%.
- Get a token: `POST /api/v1/auth/login` with the admin (`userNumber: admin`, `password: admin1234`). Use it as `Authorization: Bearer <token>` on every call below.

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
**Expect:** 2 active offers.

## 2. Evaluate a cart (`/offers/evaluate`)

> Writes nothing. `qty` and `paymentMethod` drive the result. The discount is **per line** → read `lines[].lineDiscountFils`. `freeLines` is `[]` and `invoiceDiscountFils` is `0` for this type.

**Cash, static 5% (order ≥ 10 JOD):** `24× COLA-330` (450 fils each = 10 800 fils ≥ 10 000):
```bash
curl -s "${auth[@]}" -X POST "$BASE/offers/evaluate" \
  -d '{"paymentMethod":"CASH","lines":[{"itemNumber":"COLA-330","qty":24}]}' \
  | jq '{applied:[.data.appliedOffers[].name], line:.data.lines[0]}'
```
Expect: the Cash offer applies; `lines[0].lineDiscountFils = 540` (10 800 × 5%).
- Below threshold (`qty:10` → 4 500 fils < 10 000) → `appliedOffers` empty.
- Same cart with `"paymentMethod":"CREDIT"` → Cash offer does **not** apply.

**Credit, dynamic (≥ 6 items):** base 10%, ×0.5 per 6 items, cap 25% — `6× COLA-330`:
```bash
curl -s "${auth[@]}" -X POST "$BASE/offers/evaluate" \
  -d '{"paymentMethod":"CREDIT","lines":[{"itemNumber":"COLA-330","qty":6}]}' \
  | jq '.data.lines[0].lineDiscountFils'
```
Expect: `405` — 6 items → floor(6/6)=1 step → 15% × (6×450=2 700) = 405.
- `qty:12` → 2 steps → 20%. `qty:30` → would be 35% but **capped at 25%**.
- `qty:5` (< minItemCount 6) → no offer. `"paymentMethod":"CASH"` → Credit offer does not apply.

## 3. CRUD + validation
```bash
# create a valid payment-method offer
curl -s "${auth[@]}" -X POST "$BASE/offers" -d '{
  "name":"Cash 7% over 5 JOD","type":"PAYMENT_METHOD_DISCOUNT",
  "trigger":{"paymentCondition":"CASH","minOrderTotal":5000},
  "reward":{"kind":"LINE_PERCENT_DISCOUNT","basePercent":7,"mode":"STATIC"}
}' | jq '.data | {id, status}'

# negative: missing paymentCondition → 400
curl -s -o /dev/null -w "%{http_code}\n" "${auth[@]}" -X POST "$BASE/offers" -d '{
  "name":"bad","type":"PAYMENT_METHOD_DISCOUNT","trigger":{},
  "reward":{"kind":"LINE_PERCENT_DISCOUNT","basePercent":5,"mode":"STATIC"}}'   # → 400

# negative: DYNAMIC without multiplier/itemsPerStep → 400
curl -s -o /dev/null -w "%{http_code}\n" "${auth[@]}" -X POST "$BASE/offers" -d '{
  "name":"bad2","type":"PAYMENT_METHOD_DISCOUNT","trigger":{"paymentCondition":"CASH"},
  "reward":{"kind":"LINE_PERCENT_DISCOUNT","basePercent":10,"mode":"DYNAMIC"}}'   # → 400

ID=<id-from-create>
curl -s "${auth[@]}" -X POST "$BASE/offers/$ID/toggle" | jq '.data.isActive'
curl -s "${auth[@]}" -X PATCH "$BASE/offers/$ID" -d '{"priority":50}' | jq '.data.priority'
curl -s -o /dev/null -w "%{http_code}\n" "${auth[@]}" -X DELETE "$BASE/offers/$ID"  # → 204
```

## 4. End-to-end at sale time (server-authoritative)
Offers apply automatically when a **SALE** is created — you do **not** send `appliedOfferIds`. The server reads the payment method from `payments[0].paymentType`, re-evaluates the cart, and bakes the per-line discount into each line's `discountValue`.
```bash
# CASH sale ≥ 10 JOD → Cash 5% baked into the line
curl -s "${auth[@]}" -X POST "$BASE/vouchers" -d '{
  "transKind":"SALE","userCode":"U-101","customerNumber":"C-1001",
  "payments":[{"paymentType":"CASH","amount":"10.800"}],
  "transactions":[{"itemNumber":"COLA-330","itemName":"Coca-Cola 330ml","itemQty":"24","unitPrice":"0.450"}]
}' | jq '{appliedOfferIds, lines:[.data.transactions[]|{itemNumber,discountValue,netTotal}]}'
```
Expect: `appliedOfferIds` non-empty; the COLA line carries `discountValue ≈ 0.540`. A `CREDIT` payment with ≥ 6 items applies the Credit offer instead.

Redemption ledger:
```bash
curl -s "${auth[@]}" "$BASE/offers/$OFFER_ID/redemptions" | jq '{items:.data.items, totals:.data.totals}'
```
Expect: one row per applied offer with `discountFils`. Re-creating the same `voucherNumber` is rejected (409), so redemptions never double-count.

## 5. Active-offers cache (mobile)
```bash
curl -s "${auth[@]}" "$BASE/offers/active?storeNumber=VAN-01" | jq '.data | length'
```
Expect: a plain array of active offers.

## 6. Swagger
With `SWAGGER_ENABLED=true`, browse **`/docs`** → tag **offers**.

---
### Pass criteria
- Cash offers apply on any non-CREDIT payment and only above the minimums; Credit offers apply only on CREDIT.
- Static % is applied to every line; dynamic % steps up with item count and never exceeds `maxPercent`.
- Illegal configs (missing `paymentCondition`, dynamic without `multiplier`/`itemsPerStep`, `basePercent` out of 0–100) are rejected with `400`.
- A posted SALE carries the per-line discount in `discountValue`, stamps `appliedOfferIds`, and writes one redemption per applied offer.
