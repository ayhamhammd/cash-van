# Test plan — Plan 05 · Route Plans & Stops

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

Helper to make a rep + a located customer:

```bash
REP=$(curl -s -X POST http://localhost:3000/api/v1/reps -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"nameAr":"Route Rep"}' | jq -r .data.id)
C1=$(curl -s -X POST http://localhost:3000/api/v1/customers -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"customerNumber":"RC1","customerName":"C1","latitude":"31.95","longitude":"35.91"}' | jq -r .data.id)
C2=$(curl -s -X POST http://localhost:3000/api/v1/customers -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"customerNumber":"RC2","customerName":"C2","latitude":"31.96","longitude":"35.92"}' | jq -r .data.id)
C3=$(curl -s -X POST http://localhost:3000/api/v1/customers -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"customerNumber":"RC3","customerName":"C3","latitude":"31.97","longitude":"35.93"}' | jq -r .data.id)
```

---

## 1. Migration applied

```bash
docker compose run --rm app npm run migration:show | grep AddRoutePlans
docker compose exec db psql -U cashvan -d cashvan -c "\d route_plans"
docker compose exec db psql -U cashvan -d cashvan -c "\d route_stops"
```

- [ ] `[X] AddRoutePlansAndStops...`
- [ ] Both tables exist; `route_plans` has `UNIQUE (rep_id, plan_date)`

---

## 2. Create a manual plan

```bash
PLAN=$(curl -s -X POST http://localhost:3000/api/v1/routes -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"repId\":\"$REP\",\"planDate\":\"2026-05-21\",\"stops\":[{\"customerId\":\"$C1\"},{\"customerId\":\"$C2\"},{\"customerId\":\"$C3\"}]}")
echo $PLAN | jq '{id:.data.id, source:.data.source, stops:(.data.stops|length)}'
PLAN_ID=$(echo $PLAN | jq -r .data.id)
```

- [ ] HTTP 201, `source: "manual"`, 3 stops with `stopOrder` 1..3, all `pending`

Re-POST the same rep+date:

- [ ] Returns `409 ConflictError`

---

## 3. Visit + skip + compliance

```bash
S1=$(echo $PLAN | jq -r .data.stops[0].id)
S2=$(echo $PLAN | jq -r .data.stops[1].id)

curl -s -X POST "http://localhost:3000/api/v1/routes/stops/$S1/visit" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' | jq .data.status
curl -s -X POST "http://localhost:3000/api/v1/routes/stops/$S2/skip"  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"reason":"closed"}' | jq .data.status

curl -s "http://localhost:3000/api/v1/routes/compliance?date=2026-05-21" -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] visit → `"visited"`, skip → `"skipped"`
- [ ] compliance: `totalStops:3, visited:1, skipped:1, pending:1, completionPct:33.3`

---

## 4. Reorder stops

```bash
S3=$(echo $PLAN | jq -r .data.stops[2].id)
curl -s -X PATCH "http://localhost:3000/api/v1/routes/$PLAN_ID/stops/reorder" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"order\":[{\"stopId\":\"$S3\",\"stopOrder\":1},{\"stopId\":\"$S1\",\"stopOrder\":2},{\"stopId\":\"$S2\",\"stopOrder\":3}]}" \
  | jq '.data.stops | map({id,stopOrder,status})'
```

- [ ] Stops come back ordered with S3 first
- [ ] Reordering a stop from another plan → `400`

---

## 5. Generate optimized routes

```bash
GREP=$(curl -s -X POST http://localhost:3000/api/v1/reps -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"nameAr":"Gen Rep"}' | jq -r .data.id)
for n in 1 2 3; do
  curl -s -X POST http://localhost:3000/api/v1/customers -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"customerNumber\":\"GEN$n\",\"customerName\":\"Gen$n\",\"repId\":\"$GREP\",\"latitude\":\"31.9$n\",\"longitude\":\"35.9$n\"}" > /dev/null
done

curl -s -X POST http://localhost:3000/api/v1/routes/generate -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"repIds\":[\"$GREP\"],\"planDate\":\"2026-05-22\"}" | jq '.data[0] | {source,aiEstDistance,aiEstDuration,stops:(.stops|length)}'
```

- [ ] `source: "ai_optimized"`, `aiEstDistance` > 0, `stops: 3`
- [ ] Re-running generate replaces (not duplicates) the plan for that rep+date

Accept:

```bash
GPLAN=$(curl -s "http://localhost:3000/api/v1/routes?date=2026-05-22&repId=$GREP" -H "Authorization: Bearer $TOKEN" | jq -r .data[0].id)
curl -s -X POST "http://localhost:3000/api/v1/routes/$GPLAN/accept" -H "Authorization: Bearer $TOKEN" | jq .data.acceptedAt
```

- [ ] `acceptedAt` is a timestamp

---

## 6. Deviation detection (passive, via GPS)

> Adherence keys off **today's** date. Use today's date for the plan.

```bash
TODAY=$(date +%F)
DREP=$(curl -s -X POST http://localhost:3000/api/v1/reps -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"nameAr":"Dev Rep"}' | jq -r .data.id)
DC=$(curl -s -X POST http://localhost:3000/api/v1/customers -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"customerNumber":"DEVC","customerName":"DevC","latitude":"31.95","longitude":"35.91"}' | jq -r .data.id)
curl -s -X POST http://localhost:3000/api/v1/routes -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"repId\":\"$DREP\",\"planDate\":\"$TODAY\",\"stops\":[{\"customerId\":\"$DC\"}]}" > /dev/null

# Near ping (within 500m) — no alert
curl -s -X POST "http://localhost:3000/api/v1/reps/$DREP/location" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"lat":31.951,"lng":35.911}' > /dev/null
# Far ping (km away) — alert
curl -s -X POST "http://localhost:3000/api/v1/reps/$DREP/location" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"lat":32.10,"lng":36.10}' > /dev/null

docker compose logs app --tail 20 | grep route.deviated
```

- [ ] Near ping produces NO `route.deviated` log
- [ ] Far ping logs `route.deviated rep=... plan=... nearest=<meters>`
- [ ] A second far ping does NOT re-log (debounced)

---

## 7. Roles guard

- [ ] `POST /routes` as `viewer` → 403
- [ ] `POST /routes/generate` as `viewer` → 403
- [ ] visit/skip/accept allowed for any authenticated user (rep actions)

---

## 8. Unit tests

```bash
docker compose run --rm --no-deps app npm test
```

- [ ] `Tests: 29 passed, 29 total` (includes 3 haversine tests)

---

## 9. Swagger

Open `http://localhost:3000/docs`:

- [ ] `routes` tag shows all endpoints incl. `generate`, `compliance`, stop visit/skip

---

## Done

All green → plan 05 verified. Plan 06 (Sales Invoices) next.
