# Test plan — Plan 03 · Customers + AI Profile + Visits

Manual end-to-end verification through Docker.

> **Encoding note:** PowerShell's `Invoke-RestMethod` mangles non-ASCII request
> bodies to `?`. For Arabic, use `curl.exe` (sends UTF-8 correctly) or a REST
> client like Postman/VS Code REST Client. The examples below use `curl`.

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
docker compose run --rm app npm run migration:show
```
- [ ] `[X] ExtendCustomersAndAddAiProfile1716000000000`

```bash
docker compose exec db psql -U cashvan -d cashvan -c "\d customer_ai_profile"
docker compose exec db psql -U cashvan -d cashvan -c "\d customer_visits"
docker compose exec db psql -U cashvan -d cashvan -c \
  "SELECT extname FROM pg_extension WHERE extname='pg_trgm';"
```
- [ ] Both tables exist
- [ ] `pg_trgm` extension present

---

## 2. Create a customer with Arabic name + phone

```bash
curl -s -X POST http://localhost:3000/api/v1/customers \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json; charset=utf-8' \
  -d '{"customerNumber":"C002","customerName":"بقالة النور","nameAr":"بقالة النور","phone":"0791112223","category":"retail","tin":"123456789"}' | jq
```

- [ ] HTTP 201
- [ ] `data.nameAr === "بقالة النور"`
- [ ] Response does **NOT** contain a `phoneHash` field

Verify the hash exists in the DB but differs from the phone:

```bash
docker compose exec db psql -U cashvan -d cashvan -c \
  "SELECT phone, left(phone_hash,12), octet_length(name_ar) FROM customers WHERE customer_number='C002';"
```

- [ ] `phone_hash` is a 64-hex-char value (prefix shown), not the phone
- [ ] `octet_length(name_ar)` = 21 (proper UTF-8, not 11 question marks)

---

## 3. Arabic search

```bash
# q = النور (full word)
curl -s "http://localhost:3000/api/v1/customers?q=%D8%A7%D9%84%D9%86%D9%88%D8%B1" \
  -H "Authorization: Bearer $TOKEN" | jq .data.total
# q = نور (partial, trigram)
curl -s "http://localhost:3000/api/v1/customers?q=%D9%86%D9%88%D8%B1" \
  -H "Authorization: Bearer $TOKEN" | jq .data.total
```

- [ ] Both return `1`

---

## 4. Visits

```bash
CID=$(curl -s "http://localhost:3000/api/v1/customers?q=C002" -H "Authorization: Bearer $TOKEN" | jq -r .data.items[0].id)
REP_ID=$(curl -s -X POST http://localhost:3000/api/v1/reps \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"nameAr":"Rep One"}' | jq -r .data.id)

curl -s -X POST "http://localhost:3000/api/v1/customers/$CID/visits" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"repId\":\"$REP_ID\",\"hadSale\":true,\"visitNote\":\"first visit\"}" | jq

curl -s "http://localhost:3000/api/v1/customers/$CID/visits" -H "Authorization: Bearer $TOKEN" | jq '.data | length'
```

- [ ] Visit created (201)
- [ ] List returns ≥ 1 visit

---

## 5. Reassign

```bash
curl -s -X POST "http://localhost:3000/api/v1/customers/$CID/reassign" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"newRepId\":\"$REP_ID\"}" | jq .data.repId
```

- [ ] Returns `$REP_ID`

---

## 6. AI refresh queue

```bash
curl -s -X POST "http://localhost:3000/api/v1/customers/$CID/refresh-ai" \
  -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] `data.queued === true`
- [ ] App log shows `AI-profile refresh requested for customer <id> (stub ...)`

---

## 7. AI profile join — insights + filters

Insert a profile directly (stands in for the plan-08 pipeline):

```bash
docker compose exec db psql -U cashvan -d cashvan -c \
  "INSERT INTO customer_ai_profile (customer_id, segment, churn_score, churn_risk_label, ltv_estimate, model_version, computed_at)
   VALUES ('$CID','champions',0.82,'high_risk',1500000,'stub-0',now());"
```

```bash
curl -s "http://localhost:3000/api/v1/customers/$CID/insights" -H "Authorization: Bearer $TOKEN" | jq .data.aiProfile
```

- [ ] `aiProfile.segment === "champions"`, `churnRiskLabel === "high_risk"`

```bash
curl -s "http://localhost:3000/api/v1/customers?churnRisk=high_risk" -H "Authorization: Bearer $TOKEN" | jq .data.total
curl -s "http://localhost:3000/api/v1/customers?segment=champions" -H "Authorization: Bearer $TOKEN" | jq .data.total
curl -s "http://localhost:3000/api/v1/customers?segment=loyal" -H "Authorization: Bearer $TOKEN" | jq .data.total
```

- [ ] `high_risk` → 1
- [ ] `champions` → 1
- [ ] `loyal` → 0

---

## 8. CSV import

Create `customers.csv`:

```
number,name,address,phone,category
C100,Shop A,Amman,0790000001,retail
C101,Shop B,Irbid,0790000002,wholesale
C100,Dup,X,Y,retail
,NoNumber,X,Y,retail
```

```bash
curl -s -X POST http://localhost:3000/api/v1/customers/import \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@customers.csv;type=text/csv" | jq
```

- [ ] `data.inserted === 2`
- [ ] `data.skipped === 2`
- [ ] `errors` has `row 4: duplicate C100` and `row 5: missing number or name`

---

## 9. Permissions

- [ ] Create as a user without `canAddCustomer` → 403
- [ ] `reassign` / `import` / `refresh-ai` as a `viewer` role → 403
- [ ] `reassign` as `manager` → allowed

---

## 10. Unit tests

```bash
docker compose run --rm --no-deps app npm test
```

- [ ] `Tests: 26 passed, 26 total`

---

## 11. Swagger

Open `http://localhost:3000/docs`:

- [ ] `customers` tag shows all endpoints
- [ ] `/customers/import` shows a file upload field

---

## Done

All checkboxes green → plan 03 verified. Plan 04 (Products & Inventory) next.
