# Test plan — Journey Plan → daily route generation

Verifies the per-outlet visit schedule drives which outlets land in a rep's daily
route. Runs against the Docker stack.

Prereqs:

```bash
docker compose up -d db app
docker compose run --rm app npm run migration:run   # applies AddJourneyPlanEntries
B=http://localhost:3000/api/v1
TOKEN=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r .data.accessToken)
```

Pick a rep id (`REP=...`). Create three outlets assigned to that rep, **with
coordinates** (routing skips outlets without lat/lng):

```bash
mk(){ curl -s -X POST $B/customers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"customerNumber\":\"$1\",\"customerName\":\"$2\",\"repId\":\"$REP\",\"latitude\":\"$3\",\"longitude\":\"$4\"}" | jq -r .data.id; }
CA=$(mk JP-A "Shop A" 31.953 35.910)   # daily
CB=$(mk JP-B "Shop B" 31.960 35.920)   # today only
CC=$(mk JP-C "Shop C" 31.945 35.900)   # a different weekday
```

---

## 1. Set schedules

`weekdays`: `0=Sun … 6=Sat`. Use today's day-of-week for B and a different one for C.

```bash
curl -s -X PUT "$B/reps/$REP/journey-plan/$CA" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"weekdays":[0,1,2,3,4,5,6]}' | jq .data.weekdays
curl -s -X PUT "$B/reps/$REP/journey-plan/$CB" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"weekdays":[<TODAY_DOW>]}'   | jq .data.weekdays
curl -s -X PUT "$B/reps/$REP/journey-plan/$CC" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"weekdays":[<OTHER_DOW>]}'   | jq .data.weekdays
curl -s "$B/reps/$REP/journey-plan" -H "Authorization: Bearer $TOKEN" | jq '.data | length'
```

- [ ] three entries listed, weekdays stored sorted/unique

---

## 2. Generate today's route → only due outlets appear

```bash
curl -s -X POST $B/routes/generate -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"repIds\":[\"$REP\"],\"planDate\":\"<TODAY>\"}" >/dev/null
curl -s "$B/routes?repId=$REP&date=<TODAY>" -H "Authorization: Bearer $TOKEN" \
  | jq '.data[0].stops | map(.customerId)'
```

- [ ] route contains **A** (daily) and **B** (today)
- [ ] route does **not** contain **C** (scheduled another day)
- [ ] `source` = `ai_optimized`, stops are ordered (`stopOrder` 1..n)

## 3. Generate for C's weekday → day switches

```bash
curl -s -X POST $B/routes/generate -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"repIds\":[\"$REP\"],\"planDate\":\"<DATE_ON_OTHER_DOW>\"}" >/dev/null
curl -s "$B/routes?repId=$REP&date=<DATE_ON_OTHER_DOW>" -H "Authorization: Bearer $TOKEN" \
  | jq '.data[0].stops | map(.customerId)'
```

- [ ] route now contains **A** + **C**, and **not** B

---

## 4. Validation & guards

```bash
# weekday out of range
curl -s -o /dev/null -w "%{http_code}\n" -X PUT "$B/reps/$REP/journey-plan/$CA" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"weekdays":[9]}'
# outlet assigned to another rep
curl -s -o /dev/null -w "%{http_code}\n" -X PUT "$B/reps/$REP/journey-plan/<OTHER_REPS_CUSTOMER>" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"weekdays":[1]}'
# viewer role
```

- [ ] out-of-range weekday → `400`
- [ ] outlet of another rep → `400`
- [ ] non-admin/manager → `403`

## 5. Bulk replace + delete

```bash
curl -s -X POST $B/reps/$REP/journey-plan/bulk -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"entries\":[{\"customerId\":\"$CA\",\"weekdays\":[1,4]}]}" \
  | jq '.data | length'
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE "$B/reps/$REP/journey-plan/$CA" -H "Authorization: Bearer $TOKEN"
```

- [ ] after bulk, only the listed outlet(s) remain (others removed)
- [ ] delete → `204`; deleting again → `404`

---

## Done

All green → the journey plan correctly schedules outlets per weekday and the daily
route reflects only the outlets due that day.
