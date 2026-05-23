# Test plan — Plan 09 · System: Audit Log + Notification Rules

Manual end-to-end verification through Docker.

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

## 1. Migration applied + partitions

```bash
docker compose run --rm app npm run migration:show | grep AddAuditLog
docker compose exec db psql -U cashvan -d cashvan -c \
  "SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent='audit_log'::regclass ORDER BY 1;"
docker compose exec db psql -U cashvan -d cashvan -c "\d notification_rules" | grep -E "trigger|channel|recipients"
docker compose logs app --tail 60 | grep AuditPartition
```

- [ ] `[X] AddAuditLogAndNotificationRules...`
- [ ] `audit_log` has current-month, next-month, and `audit_log_default` partitions
- [ ] `notification_rules` has trigger/channel/recipients
- [ ] Boot log: `Ensured audit partition audit_log_<next>`

---

## 2. Mutations are audited automatically

```bash
CID=$(curl -s -X POST http://localhost:3000/api/v1/customers -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"customerNumber":"AUD1","customerName":"Audit Cust"}' | jq -r .data.id)
curl -s -X PATCH "http://localhost:3000/api/v1/customers/$CID" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"city":"Amman"}' > /dev/null

curl -s "http://localhost:3000/api/v1/audit-log/customers/$CID" -H "Authorization: Bearer $TOKEN" | jq '.data | map({action,entityId})'
```

- [ ] Two rows: a `create` (entityId = the new customer id) and an `update`
- [ ] Each row has a non-null `actorId` and an `ipAddress`
- [ ] The `update` row's `diffJson.body` shows `{ "city": "Amman" }`

---

## 3. Secrets are redacted

```bash
# rotate JoFotara secret (a mutation with a secretKey field)
curl -s -X PATCH http://localhost:3000/api/v1/settings/jofotara -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"clientId":"abc","secretKey":"top-secret-123"}' > /dev/null
curl -s "http://localhost:3000/api/v1/audit-log?entity=settings&limit=1" -H "Authorization: Bearer $TOKEN" | jq '.data.items[0].diffJson'
```

- [ ] `secretKey` shows `***`, not `top-secret-123`

---

## 4. GET is not audited; login is skipped

```bash
curl -s "http://localhost:3000/api/v1/customers" -H "Authorization: Bearer $TOKEN" > /dev/null
curl -s -X POST http://localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' > /dev/null
curl -s "http://localhost:3000/api/v1/audit-log?entity=auth" -H "Authorization: Bearer $TOKEN" | jq .data.total
```

- [ ] No `auth` entity rows (login is `@SkipAudit()`)
- [ ] No row created by the GET /customers call

---

## 5. Notification rule CRUD + test

```bash
RULE=$(curl -s -X POST http://localhost:3000/api/v1/notification-rules -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"High anomaly alert","trigger":"anomaly_high","channel":"email"}' | jq -r .data.id)
curl -s http://localhost:3000/api/v1/notification-rules -H "Authorization: Bearer $TOKEN" | jq '.data | length'
curl -s -X POST "http://localhost:3000/api/v1/notification-rules/$RULE/test" -H "Authorization: Bearer $TOKEN" | jq
docker compose logs app --tail 10 | grep NotificationDispatcher
```

- [ ] Rule created with `trigger: anomaly_high`, `channel: email`
- [ ] list length ≥ 1
- [ ] test → `{ matched: 1 }`
- [ ] dispatcher log: `[email] → ... :: [VanFlow] High anomaly alert :: Trigger 'anomaly_high' fired: {...}`

---

## 6. Audit query filters

```bash
curl -s "http://localhost:3000/api/v1/audit-log?entity=customers&limit=5" -H "Authorization: Bearer $TOKEN" | jq .data.total
curl -s "http://localhost:3000/api/v1/audit-log?actorId=<your-user-id>" -H "Authorization: Bearer $TOKEN" | jq .data.total
```

- [ ] entity filter narrows to customers rows
- [ ] actorId filter works

---

## 7. Permissions

- [ ] `GET /audit-log*` as `manager` or `viewer` → 403 (admin-only)
- [ ] `notification-rules` CRUD as `viewer` → 403 (admin/manager only)

---

## 8. Unit tests

```bash
docker compose run --rm --no-deps app npm test
```

- [ ] `Tests: 35 passed, 35 total`

---

## 9. Swagger

Open `http://localhost:3000/docs`:

- [ ] `audit-log` and `notification-rules` tags present

---

## Done

All green → plan 09 verified. Remaining: 10 (Realtime WebSocket), 11 (JoFotara), 08 (AI).
