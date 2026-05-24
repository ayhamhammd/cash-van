# Test plan — Plan 13 · Mobile BFF

End-to-end through Docker. Verifies the four mobile endpoints reproduce the
frontend contract's field names (inside our `{ success, data, timestamp }` envelope).

> **Arabic / UTF-8:** send request bodies that contain Arabic from a **UTF-8 file**
> (`--data-binary @file.json`). Passing Arabic inline via a shell can mangle it to
> `?` depending on your terminal locale — that's a client artifact, not the backend.

Prereqs:

```bash
docker compose up -d db app
docker compose run --rm app npm run migration:run   # applies AddFrontendBffFields
B=http://localhost:3000/api/v1
TOKEN=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r .data.accessToken)
A="Authorization: Bearer $TOKEN"
```

## 1. Admin setup

```bash
curl -s -X PATCH $B/settings -H "$A" -H 'Content-Type: application/json' \
  -d '{"companyNumber":"C001","logoUrl":"https://cdn.example.com/logo.png","companyNameEn":"CashFlow Trading","sellerTin":"23423423","sellerPhone":"0793232334"}' >/dev/null
REG=$(curl -s -X POST $B/regions -H "$A" -H 'Content-Type: application/json' -d '{"code":"R-A01","nameAr":"وسط عمان","nameEn":"Central Amman Route"}' | jq -r .data.id)
WH=$(curl -s -X POST $B/warehouses -H "$A" -H 'Content-Type: application/json' -d '{"whNumber":"4","whName":"Sales Van"}' | jq -r .data.id)
REP=<an existing rep id>
curl -s -X PATCH $B/reps/$REP -H "$A" -H 'Content-Type: application/json' \
  -d "{\"code\":\"S012\",\"regionId\":\"$REG\",\"vanId\":\"$WH\",\"phone\":\"0791234567\",\"nameEn\":\"Ahmad Al-Masri\"}" >/dev/null
CAT=$(curl -s -X POST $B/product-categories -H "$A" -H 'Content-Type: application/json' -d '{"nameAr":"مشروبات","nameEn":"Drinks"}' | jq -r .data.id)
curl -s -X POST $B/products -H "$A" -H 'Content-Type: application/json' \
  -d "{\"itemNumber\":\"23232\",\"barcode\":\"4533455\",\"name\":\"Baraka Water\",\"nameAr\":\"مياه بركة\",\"nameEn\":\"Baraka Water 1.5L\",\"price\":350,\"taxRate\":0.16,\"categoryId\":\"$CAT\",\"imageUrl\":\"https://cdn.example.com/items/23232.jpg\"}" >/dev/null
curl -s -X POST $B/items/switches -H "$A" -H 'Content-Type: application/json' -d '{"itemNumber":"23232","barcode":"4423523","unitQty":1,"salePrice":"0.350","itemName":"Baraka","unitName":"piece"}' >/dev/null
curl -s -X POST $B/items/switches -H "$A" -H 'Content-Type: application/json' -d '{"itemNumber":"23232","barcode":"4423524","unitQty":24,"salePrice":"8.400","itemName":"Baraka","unitName":"carton"}' >/dev/null
```

- [ ] `reps.code` rejects a duplicate code → `409`

## 2. The four endpoints

```bash
curl -s "$B/mobile/salesman/S012?companyNumber=C001" -H "$A" | jq .data
curl -s "$B/mobile/company/meta?companyNumber=C001" -H "$A" -H 'X-Salesman-Code: S012' | jq .data
curl -s "$B/mobile/items/23232?companyNumber=C001&salesmanCode=S012" -H "$A" | jq .data
curl -s "$B/mobile/itemBalance?companyNumber=C001&salesmanCode=S012&itemNumber=23232" -H "$A" | jq .data
```

- [ ] **salesman**: `salesmanCode "S012"`, `routeCode "R-A01"`, `storeNumber "4"`, `pricePhase "1"`, names/phone present
- [ ] **company/meta**: `companyName`, `taxNumber`, `companyPhone`, `logo` present; `salesmanCode` echoed (from header)
- [ ] **items**: `itemPrice "0.350"`, `taxPerc "16"`, `itemCategory "Drinks"`, `itemUnits[]` with `unitCode`/`unitPrice`/`unitQty`, `itemPriceList [{phaseNumber:"1",phasePrice:"0.350"}]`
- [ ] **itemBalance**: `data` is an **array** (empty until posted-voucher stock exists)

## 3. Common-params guard

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$B/mobile/company/meta?salesmanCode=S012" -H "$A"             # 400 missing companyNumber
curl -s -o /dev/null -w "%{http_code}\n" "$B/mobile/company/meta?companyNumber=C999&salesmanCode=S012" -H "$A"  # 400 wrong company
curl -s -o /dev/null -w "%{http_code}\n" "$B/mobile/salesman/S999?companyNumber=C001" -H "$A"            # 404 unknown salesman
curl -s -o /dev/null -w "%{http_code}\n" "$B/mobile/items/NOPE?companyNumber=C001&salesmanCode=S012" -H "$A"   # 404 unknown item
curl -s -o /dev/null -w "%{http_code}\n" "$B/mobile/company/meta?companyNumber=C001&salesmanCode=S012"   # 401 no token
```

- [ ] codes are `400 / 400 / 404 / 404 / 401`

## 4. UTF-8 round-trip (proves storage, not the shell)

```bash
printf '{"nameAr":"مياه معدنية بركة 1.5 لتر"}' > /tmp/ar.json
PID=$(curl -s "$B/products?q=23232" -H "$A" | jq -r '.data.items[0].id // .data[0].id')
curl -s -X PATCH "$B/products/$PID" -H "$A" -H 'Content-Type: application/json; charset=utf-8' --data-binary @/tmp/ar.json >/dev/null
docker compose exec -T db psql -U cashvan -d cashvan -c "SELECT octet_length(name_ar) bytes, char_length(name_ar) chars FROM item_cart WHERE item_number='23232';"
```

- [ ] `bytes > chars` (multi-byte UTF-8 stored; e.g. 41 bytes / 24 chars). `bytes == chars` would mean the client mangled it to ASCII.

---

## Done

All green → the mobile BFF reproduces the frontend contract over existing data.
