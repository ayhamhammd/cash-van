# Test plan — Plan 07 · Cash & Cheque Collections

Manual end-to-end verification through Docker.

Prereqs:

```bash
docker compose up -d db app
docker compose run --rm app npm run migration:run
docker compose run --rm app npm run seed
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r .data.accessToken)

REP=$(curl -s -X POST http://localhost:3000/api/v1/reps -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"nameAr":"Coll Rep"}' | jq -r .data.id)
CUST=$(curl -s -X POST http://localhost:3000/api/v1/customers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"customerNumber":"COLC","customerName":"Coll Cust"}' | jq -r .data.id)
```

---

## 1. Migration applied

```bash
docker compose run --rm app npm run migration:show | grep AddCollections
docker compose exec db psql -U cashvan -d cashvan -c "\d collections" | grep -E "method|status|payment_id"
docker compose exec db psql -U cashvan -d cashvan -c "\d cheques" | grep -E "words_match|reconciled_at|payment_cheque_id"
```

- [ ] `[X] AddCollectionsAndCheques...`
- [ ] `collections` has method/status/payment_id (legacy bridge)
- [ ] `cheques` has words_match/reconciled_at/payment_cheque_id

---

## 2. Cash collection lifecycle

```bash
CASH=$(curl -s -X POST http://localhost:3000/api/v1/collections -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"repId\":\"$REP\",\"customerId\":\"$CUST\",\"amount\":100000,\"method\":\"cash\"}" | jq -r .data.id)

curl -s -X POST "http://localhost:3000/api/v1/collections/$CASH/confirm" -H "Authorization: Bearer $TOKEN" | jq .data.status
curl -s -X POST http://localhost:3000/api/v1/collections/batch-deposit -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"collectionIds\":[\"$CASH\"]}" | jq
```

- [ ] create → `pending`
- [ ] confirm → `confirmed`
- [ ] batch-deposit → `{ deposited: 1, skipped: [] }`

---

## 3. Daily summary

```bash
curl -s "http://localhost:3000/api/v1/collections/summary" -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] `totalCollectedFils: 100000`, `cashFils: 100000`, `chequeFils: 0`, `pendingFils: 0`

---

## 4. Cheque mismatch → reconcile → confirm

```bash
CHQ=$(curl -s -X POST http://localhost:3000/api/v1/collections -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"repId\":\"$REP\",\"customerId\":\"$CUST\",\"amount\":250000,\"method\":\"cheque\",\"cheque\":{\"bankName\":\"Arab Bank\",\"chequeNumber\":\"CHK-001\",\"amountWords\":\"two hundred fifty\",\"dueDate\":\"2026-05-01\",\"wordsMatch\":false}}")
COL=$(echo $CHQ | jq -r .data.id)
CHEQUE=$(echo $CHQ | jq -r .data.cheque.id)

# confirm should be blocked
curl -i -s -X POST "http://localhost:3000/api/v1/collections/$COL/confirm" -H "Authorization: Bearer $TOKEN" | head -1
```

- [ ] cheque created with `wordsMatch: false`
- [ ] confirm → HTTP `409` ("amount-in-words mismatch must be reconciled")

```bash
curl -s "http://localhost:3000/api/v1/cheques/reconcile/queue" -H "Authorization: Bearer $TOKEN" | jq '.data | length'
curl -s -X POST "http://localhost:3000/api/v1/cheques/$CHEQUE/reconcile" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"amount":250000,"amountWords":"مئتان وخمسون"}' | jq '{wordsMatch:.data.wordsMatch, reconciledAt:.data.reconciledAt}'
curl -s -X POST "http://localhost:3000/api/v1/collections/$COL/confirm" -H "Authorization: Bearer $TOKEN" | jq .data.status
```

- [ ] reconcile queue length ≥ 1
- [ ] after reconcile: `wordsMatch: true`, `reconciledAt` set, `reconciledBy` = your user id
- [ ] confirm now → `confirmed`

---

## 5. Aging

```bash
curl -s "http://localhost:3000/api/v1/collections/aging" -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] The cheque due `2026-05-01` lands in the bucket matching its days-overdue
- [ ] `totalOutstandingFils` = sum of pending-cheque amounts
- [ ] Bucket amounts sum to `totalOutstandingFils`

---

## 6. Bank export

```bash
curl -s -o cheque-clearing.csv -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/v1/cheques/export/bank"
cat cheque-clearing.csv
```

- [ ] CSV header `bank_name,cheque_number,payee,amount_jod,due_date`
- [ ] Amounts shown in JOD (e.g. `250.000`)

---

## 7. Clear / bounce

```bash
CHEQUE=$(curl -s "http://localhost:3000/api/v1/cheques?status=pending" -H "Authorization: Bearer $TOKEN" | jq -r '.data[0].id')
curl -s -X POST "http://localhost:3000/api/v1/cheques/$CHEQUE/mark-cleared" -H "Authorization: Bearer $TOKEN" | jq .data.status
```

- [ ] → `cleared` (after clearing it leaves the pending aging/export lists)

---

## 8. Permissions

- [ ] `batch-deposit`, cheque `reconcile`/`mark-cleared`/`mark-bounced`/`export` as `viewer` → 403
- [ ] `create` / `confirm` collection allowed for any authenticated user (rep actions)

---

## 9. Unit tests

```bash
docker compose run --rm --no-deps app npm test
```

- [ ] `Tests: 35 passed, 35 total`

---

## 10. Swagger

Open `http://localhost:3000/docs`:

- [ ] `collections` and `cheques` tags present with all endpoints

---

## Done

All green → plan 07 verified. Next: plan 08 (AI features) or plan 09 (System/Audit).
