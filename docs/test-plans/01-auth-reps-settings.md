# Test plan — Plan 01 · Auth, Reps, App Settings

Manual end-to-end verification. Run everything through Docker.

```bash
docker compose up -d db app
docker compose run --rm app npm run migration:run   # if not already applied
docker compose run --rm app npm run seed             # creates admin/admin1234
docker compose logs -f app
```

You'll need an HTTP client (`curl`, REST Client, Postman). All commands assume the API is at `http://localhost:3000`.

---

## 1. Stack starts cleanly

```bash
docker compose logs app --tail 20
```

- [ ] No errors
- [ ] Shows `[JobsService] pg-boss started`
- [ ] Shows `Cash Van API listening on http://0.0.0.0:3000`
- [ ] Mapped routes include `/api/reps`, `/api/reps/:id/kpis`, `/api/settings`, `/api/settings/jofotara`

---

## 2. Migration ran & seeded

```bash
docker compose run --rm app npm run migration:show
```
- [ ] Shows `[X] AddRepsAndAppSettings1715800000000`

```bash
docker compose exec db psql -U cashvan -d cashvan -c \
  "SELECT id, company_name_ar, locale FROM app_settings;"
```
- [ ] Returns exactly one row (`id = 1`, `company_name_ar = 'My Company'`)

```bash
docker compose exec db psql -U cashvan -d cashvan -c \
  "SELECT user_number, role FROM users WHERE user_number='admin';"
```
- [ ] Row exists, `role = admin`

---

## 3. Login returns role + v:2

```bash
LOGIN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}')
echo $LOGIN | jq
TOKEN=$(echo $LOGIN | jq -r .data.accessToken)
```

- [ ] HTTP 200
- [ ] `data.user.role === "admin"`
- [ ] Decode the JWT at jwt.io → payload has `"v": 2`, `"role": "admin"`

---

## 4. Settings — initial state

```bash
curl -s http://localhost:3000/api/v1/settings -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] HTTP 200
- [ ] `data.companyNameAr === "My Company"`
- [ ] `data.jofotara.isConfigured === false`
- [ ] `data.jofotara.secretLast4 === null`

---

## 5. Settings — patch non-secret fields

```bash
curl -s -X PATCH http://localhost:3000/api/v1/settings \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"companyNameAr":"شركة ABC للتجارة","companyNameEn":"ABC Trading","sellerTin":"123456789","sellerCityCode":"JO-AM"}' | jq
```

- [ ] HTTP 200
- [ ] Returned `data.companyNameAr` reflects the update
- [ ] `data.updatedBy` is the admin's UUID

---

## 6. Settings — rotate JoFotara credentials

```bash
curl -s -X PATCH http://localhost:3000/api/v1/settings/jofotara \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"clientId":"abc-trading","secretKey":"super-secret-1234","sandbox":true}' | jq
```

- [ ] HTTP 200
- [ ] `data.secretLast4 === "1234"`
- [ ] **Plaintext `super-secret-1234` is NOT in the response**

Re-GET to confirm persistence:

```bash
curl -s http://localhost:3000/api/v1/settings -H "Authorization: Bearer $TOKEN" | jq .data.jofotara
```

- [ ] `clientId === "abc-trading"`, `secretLast4 === "1234"`, `isConfigured === true`

Inspect the DB to confirm encryption:

```bash
docker compose exec db psql -U cashvan -d cashvan -c \
  "SELECT jofotara_secret_key_encrypted FROM app_settings;"
```

- [ ] Column contains a base64 blob, NOT the plaintext `super-secret-1234`

---

## 7. Reps — create

```bash
curl -s -X POST http://localhost:3000/api/v1/reps \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"nameAr":"خالد العلي","nameEn":"Khaled","phone":"+962790000001","dailyQuotaFils":500000}' | jq
```

- [ ] HTTP 201
- [ ] Returned `data.id` is a UUID
- [ ] `data.dailyQuotaFils === 500000`
- [ ] Save the UUID as `$REP_ID`

---

## 8. Reps — list with filters

```bash
curl -s "http://localhost:3000/api/v1/reps?isActive=true&q=خالد" -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] HTTP 200
- [ ] `data.total >= 1`
- [ ] The created rep appears in `data.items`

---

## 9. Reps — KPI stub

```bash
curl -s "http://localhost:3000/api/v1/reps/$REP_ID/kpis" -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] HTTP 200
- [ ] `data === { todayRevenueFils: 0, routeCompletionPct: 0, invoicesToday: 0, customersAtRisk: 0 }`

---

## 10. Reps — patch

```bash
curl -s -X PATCH "http://localhost:3000/api/v1/reps/$REP_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"isActive":false}' | jq
```

- [ ] HTTP 200
- [ ] `data.isActive === false`

---

## 11. Roles guard — non-admin cannot delete a rep

Demote admin temporarily for the test:

```bash
docker compose exec db psql -U cashvan -d cashvan -c \
  "UPDATE users SET role='manager' WHERE user_number='admin';"
```

Re-login (token must be re-issued to pick up new role):

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r .data.accessToken)
```

Attempt DELETE:

```bash
curl -i -X DELETE "http://localhost:3000/api/v1/reps/$REP_ID" \
  -H "Authorization: Bearer $TOKEN"
```

- [ ] HTTP 403
- [ ] Body matches the shared error envelope
- [ ] `error === "ForbiddenException"`, `message` mentions role `manager` not permitted

Restore:

```bash
docker compose exec db psql -U cashvan -d cashvan -c \
  "UPDATE users SET role='admin' WHERE user_number='admin';"
```

---

## 12. Roles guard — admin can delete

Re-login as admin then DELETE:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r .data.accessToken)

curl -i -X DELETE "http://localhost:3000/api/v1/reps/$REP_ID" \
  -H "Authorization: Bearer $TOKEN"
```

- [ ] HTTP 204
- [ ] `GET /api/v1/reps` no longer lists the soft-deleted rep (list filters `deleted_at IS NULL`)

---

## 13. Unit tests pass

```bash
docker compose run --rm --no-deps app npm test
```

- [ ] `Test Suites: 3 passed, 3 total`
- [ ] `Tests: 26 passed, 26 total` (currency 11 + geo 8 + crypto 7)

---

## 14. Swagger updated

Open `http://localhost:3000/docs` in a browser.

- [ ] `reps` and `settings` tags visible
- [ ] All endpoints documented with request/response schemas
- [ ] Bearer auth button works

---

## Done

When all checkboxes pass, plan 01 is verified. Plan 02 (Territories) can proceed.
