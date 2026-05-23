# Test plan — Plan 02 · Territories & Geography

Manual end-to-end verification through Docker.

Prereqs (run once):

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

- [ ] Output includes `[X] AddRegionsAndLocationEvents1715900000000`

```bash
docker compose exec db psql -U cashvan -d cashvan -c \
  "SELECT inhrelid::regclass FROM pg_inherits
   WHERE inhparent = 'rep_location_events'::regclass ORDER BY 1;"
```

- [ ] Lists `rep_location_events_<YYYYMM>` for current and next month
- [ ] Lists `rep_location_events_default`

---

## 2. FKs added to plan-01 columns

```bash
docker compose exec db psql -U cashvan -d cashvan -c \
  "SELECT conname FROM pg_constraint WHERE conname IN ('fk_reps_region_id','fk_users_region_id');"
```

- [ ] Both FK names returned

---

## 3. App start logs the partition cron

```bash
docker compose logs app --tail 60 | grep PartitionMaintenance
```

- [ ] One log line `Ensured partition rep_location_events_<next YYYYMM> ...`

---

## 4. Region — create + roundtrip GeoJSON

```bash
curl -s -X POST http://localhost:3000/api/v1/regions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "nameAr":"شمال عمان","nameEn":"North Amman",
    "boundary":{"type":"Polygon","coordinates":[[
      [35.85,31.95],[35.95,31.95],[35.95,32.05],[35.85,32.05],[35.85,31.95]
    ]]}
  }' | jq
```

- [ ] HTTP 201
- [ ] `data.boundary.coordinates[0]` is the same 5-position ring you sent
- [ ] Save `data.id` as `$REGION_ID`

```bash
curl -s "http://localhost:3000/api/v1/regions/$REGION_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .data.boundary
```

- [ ] Boundary matches the original

---

## 5. Region — point-in-polygon

Inside:

```bash
curl -s "http://localhost:3000/api/v1/regions/containing?lat=32.0&lng=35.9" \
  -H "Authorization: Bearer $TOKEN" | jq .data.nameEn
```

- [ ] Returns `"North Amman"`

Outside:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:3000/api/v1/regions/containing?lat=40&lng=0" \
  -H "Authorization: Bearer $TOKEN"
```

- [ ] HTTP `404`

Non-numeric:

```bash
curl -s "http://localhost:3000/api/v1/regions/containing?lat=foo&lng=35.9" \
  -H "Authorization: Bearer $TOKEN" | jq .error
```

- [ ] Error includes `BadRequestException`

---

## 6. Region — invalid GeoJSON rejected

```bash
curl -s -X POST http://localhost:3000/api/v1/regions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"nameAr":"bad","boundary":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1]]]}}' | jq
```

- [ ] HTTP 400
- [ ] `message` mentions polygon ring must be closed

---

## 7. Reps — create + single GPS ping

```bash
REP_ID=$(curl -s -X POST http://localhost:3000/api/v1/reps \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"nameAr":"احمد","nameEn":"Ahmad"}' | jq -r .data.id)

curl -s -X POST "http://localhost:3000/api/v1/reps/$REP_ID/location" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"lat":32.0,"lng":35.9,"accuracyM":12}' | jq
```

- [ ] HTTP 201
- [ ] `data.id` is a bigint string
- [ ] `data.recordedAt` is a recent timestamp

---

## 8. Reps — bulk upload

```bash
curl -s -X POST "http://localhost:3000/api/v1/reps/$REP_ID/location/bulk" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"points":[
    {"lat":32.001,"lng":35.901},
    {"lat":32.002,"lng":35.902},
    {"lat":32.003,"lng":35.903},
    {"lat":32.004,"lng":35.904},
    {"lat":32.005,"lng":35.905}
  ]}' | jq
```

- [ ] HTTP 201
- [ ] `data.accepted === 5`

Try a payload with 501 points:

- [ ] HTTP 400, message mentions `maxSize`

---

## 9. Reps — live map

```bash
curl -s http://localhost:3000/api/v1/reps/locations/latest \
  -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] HTTP 200
- [ ] One entry per rep that has pinged in the last 24h
- [ ] Latest entry's `status === "online"` (since the ping was just made)
- [ ] Entries include `nameAr / nameEn / lat / lng / recordedAt / status`

---

## 10. Reps — replay window

```bash
curl -s "http://localhost:3000/api/v1/reps/$REP_ID/locations?limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq '.data | length'
```

- [ ] Number of points returned ≥ 6 (1 single + 5 bulk from steps 7 + 8)
- [ ] Points are ordered ascending by `recordedAt`

---

## 11. Reps — GeoJSON export

```bash
curl -s "http://localhost:3000/api/v1/reps/$REP_ID/locations.geojson" \
  -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] `data.type === "FeatureCollection"`
- [ ] `data.features[0].geometry.type === "LineString"`
- [ ] `data.features[0].geometry.coordinates` is `[[lng, lat], ...]` in order
- [ ] `data.features[0].properties.pointCount` matches step 10's count

Paste the result into [geojson.io](https://geojson.io) — the line should sit in Amman.

---

## 12. Region deletion cascade (SET NULL)

Assign the rep to the region:

```bash
curl -s -X PATCH "http://localhost:3000/api/v1/reps/$REP_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"regionId\":\"$REGION_ID\"}" | jq .data.regionId
```

- [ ] Returns the region UUID

Delete the region:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X DELETE "http://localhost:3000/api/v1/regions/$REGION_ID" \
  -H "Authorization: Bearer $TOKEN"
```

- [ ] HTTP 204

Soft-deletes don't trigger the FK cascade (the row still exists). Try a hard delete via SQL to confirm the FK constraint behavior:

```bash
docker compose exec db psql -U cashvan -d cashvan -c \
  "DELETE FROM regions WHERE id = (SELECT id FROM regions WHERE deleted_at IS NOT NULL LIMIT 1);"
docker compose exec db psql -U cashvan -d cashvan -c \
  "SELECT name_ar, region_id FROM reps WHERE id = '$REP_ID';"
```

- [ ] `region_id` is NULL (FK `ON DELETE SET NULL` worked)

---

## 13. Roles guard — DELETE region is admin-only

```bash
docker compose exec db psql -U cashvan -d cashvan -c \
  "UPDATE users SET role='manager' WHERE user_number='admin';"
TOKEN_MANAGER=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r .data.accessToken)
curl -i -X DELETE "http://localhost:3000/api/v1/regions/some-uuid" \
  -H "Authorization: Bearer $TOKEN_MANAGER"
# restore
docker compose exec db psql -U cashvan -d cashvan -c \
  "UPDATE users SET role='admin' WHERE user_number='admin';"
```

- [ ] HTTP 403
- [ ] `error === "ForbiddenException"`

---

## 14. Unit tests pass

```bash
docker compose run --rm --no-deps app npm test
```

- [ ] `Tests: 26 passed, 26 total`

---

## 15. Swagger updated

Open `http://localhost:3000/docs`:

- [ ] `regions` and `reps-locations` tags present
- [ ] Region create body includes the example GeoJSON polygon
- [ ] Bulk location body shows `points` array shape

---

## Done

When all checkboxes pass, plan 02 is verified. Plan 03 (Customers) can proceed.
