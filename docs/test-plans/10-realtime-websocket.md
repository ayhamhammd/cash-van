# Test plan — Plan 10 · Realtime WebSocket (`/ws/ops`)

End-to-end verification through Docker. WebSocket testing is awkward from
PowerShell/curl, so use the bundled `scripts/ws-smoke.js` (runs inside the
container, which has `socket.io-client`).

Prereqs:

```bash
docker compose up -d db app
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r .data.accessToken)
```

The helper: `node scripts/ws-smoke.js <token> <waitMs>` connects, prints every
received event, then exits after `waitMs`.

---

## 1. App starts with the gateway

```bash
docker compose logs app | grep -i "Nest application successfully started"
```

- [ ] App boots cleanly (the `/ws/ops` gateway initializes with it)

---

## 2. Valid token connects and receives `rep.location`

Terminal A (start the client for 9s):

```bash
docker compose exec app node scripts/ws-smoke.js "$TOKEN" 9000
```

Terminal B (within those 9s, push a ping):

```bash
REP=$(curl -s -X POST http://localhost:3000/api/v1/reps -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"nameAr":"WS Rep"}' | jq -r .data.id)
curl -s -X POST "http://localhost:3000/api/v1/reps/$REP/location" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"lat":31.95,"lng":35.91}' > /dev/null
```

- [ ] Terminal A prints `CONNECTED ...`
- [ ] Terminal A prints `EVENT rep.location {"rep_id":...,"lat":31.95,...}`
- [ ] Event arrives within ~1s of the POST (≤ 500ms server-emit latency)

---

## 3. `invoice.confirmed` over WebSocket

Terminal A: start the client (9s). Terminal B: confirm an invoice.

```bash
CUST=$(curl -s -X POST http://localhost:3000/api/v1/customers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"customerNumber":"WSC","customerName":"WS Cust"}' | jq -r .data.id)
PROD=$(curl -s -X POST http://localhost:3000/api/v1/products -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"itemNumber":"WSP","barcode":"B-WSP","name":"WS Prod","price":10000}' | jq -r .data.id)
INV=$(curl -s -X POST http://localhost:3000/api/v1/invoices -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"repId\":\"$REP\",\"customerId\":\"$CUST\",\"lines\":[{\"productId\":\"$PROD\",\"quantity\":1}]}" | jq -r .data.id)
curl -s -X POST "http://localhost:3000/api/v1/invoices/$INV/confirm" -H "Authorization: Bearer $TOKEN" > /dev/null
```

- [ ] Terminal A prints `EVENT invoice.confirmed {"invoice_id":...,"total":11600}`

---

## 4. Bad / missing token is refused

```bash
docker compose exec app node scripts/ws-smoke.js "not-a-jwt" 4000
docker compose exec app node scripts/ws-smoke.js "" 4000
```

- [ ] Both print `DISCONNECTED io server disconnect`
- [ ] `RECEIVED_SUMMARY []` (no events delivered to an unauthenticated socket)

---

## 5. `route.deviated` over WebSocket (optional)

With a client connected, reproduce plan 05 step 6 (today's plan + a far GPS
ping for that rep).

- [ ] Terminal A prints `EVENT route.deviated {"rep_id":...,"deviation_m":...}`

---

## 6. `rep.offline` heartbeat (optional, slow)

The watchdog runs every minute and emits `rep.offline` for active reps with no
ping in 2h. To verify quickly you can temporarily lower `OFFLINE_MS` in
`heartbeat-watchdog.service.ts`, or insert an old `rep_location_events` row and
wait for the next minute tick.

- [ ] With a stale-but-active rep, a connected client receives `rep.offline` once
- [ ] It does not re-fire every minute (debounced)

---

## 7. Unit tests

```bash
docker compose run --rm --no-deps app npm test
```

- [ ] `Tests: 35 passed, 35 total`

---

## Done

All green → plan 10 verified. Remaining: 11 (JoFotara), 08 (AI).
