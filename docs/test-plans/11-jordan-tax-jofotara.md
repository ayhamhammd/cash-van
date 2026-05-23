# Test plan — Plan 11 · Jordan Tax & JoFotara

End-to-end verification through Docker. Runs in **mock mode** (`JOFOTARA_MOCK=true`)
so no real ISTD call is made; the full validate → build → submit → writeback →
ledger pipeline still executes.

Prereqs:

```bash
docker compose up -d db app
docker compose run --rm app npm run migration:run
docker compose run --rm app npm run seed
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r .data.accessToken)
```

Set seller TIN (required by the validator), then create a rep/customer/product:

```bash
curl -s -X PATCH http://localhost:3000/api/v1/settings -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"sellerTin":"123456789","companyNameEn":"ABC Trading"}' > /dev/null
REP=$(curl -s -X POST http://localhost:3000/api/v1/reps -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"nameAr":"Tax Rep"}' | jq -r .data.id)
CUST=$(curl -s -X POST http://localhost:3000/api/v1/customers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"customerNumber":"TAXC","customerName":"Tax Cust"}' | jq -r .data.id)
PROD=$(curl -s -X POST http://localhost:3000/api/v1/products -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"itemNumber":"TAXP","barcode":"B-TAXP","name":"Tax Prod","price":250000,"taxType":"TAXABLE","taxCategory":"S","taxRate":0.16}' | jq -r .data.id)
```

---

## 1. Migration + view

```bash
docker compose run --rm app npm run migration:show | grep AddCreditNotes
docker compose exec db psql -U cashvan -d cashvan -c "\dv invoice_line_returnable_qty"
docker compose exec db psql -U cashvan -d cashvan -c "\dt credit_notes credit_note_lines tax_ledger_entries jofotara_submission_log"
```

- [ ] `[X] AddCreditNotesTaxLedgerJoFotara...`
- [ ] view + 4 tables exist

---

## 2. Confirm invoice → auto-submit (mock)

```bash
INV=$(curl -s -X POST http://localhost:3000/api/v1/invoices -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"repId\":\"$REP\",\"customerId\":\"$CUST\",\"lines\":[{\"productId\":\"$PROD\",\"quantity\":2}]}" | jq -r .data.id)
curl -s -X POST "http://localhost:3000/api/v1/invoices/$INV/confirm" -H "Authorization: Bearer $TOKEN" > /dev/null
sleep 2
curl -s "http://localhost:3000/api/v1/invoices/$INV" -H "Authorization: Bearer $TOKEN" | jq '.data | {jofotaraStatus,jofotaraQrCode,jofotaraRegistrationNumber}'
curl -s "http://localhost:3000/api/v1/jofotara/submissions/$INV/log" -H "Authorization: Bearer $TOKEN" | jq '.data | map({attempt,responseStatus,error})'
```

- [ ] `jofotaraStatus: "VALIDATED"`, `jofotaraQrCode` like `MOCK-QR-...`, registration set
- [ ] submission log has one attempt, `responseStatus: 200`, `error: null`

---

## 3. Credit note (return 1 of 2)

```bash
LINE=$(curl -s "http://localhost:3000/api/v1/invoices/$INV" -H "Authorization: Bearer $TOKEN" | jq -r '.data.lines[0].id')
curl -s "http://localhost:3000/api/v1/invoices/$INV/returnable" -H "Authorization: Bearer $TOKEN" | jq    # returnable: 2
CN=$(curl -s -X POST http://localhost:3000/api/v1/credit-notes -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"originalInvoiceId\":\"$INV\",\"reason\":\"damaged\",\"lines\":[{\"invoiceLineId\":\"$LINE\",\"returnQuantity\":1}]}")
echo $CN | jq '.data | {creditNoteNumber,subtotal,totalReturnTax,grandReturnTotal,jofotaraStatus}'
sleep 2
curl -s "http://localhost:3000/api/v1/credit-notes/$(echo $CN | jq -r .data.id)" -H "Authorization: Bearer $TOKEN" | jq .data.jofotaraStatus
curl -s "http://localhost:3000/api/v1/invoices/$INV/returnable" -H "Authorization: Bearer $TOKEN" | jq '.data[0].returnableQty'
```

- [ ] credit note: `subtotal 250000`, `totalReturnTax 40000`, `grandReturnTotal 290000`
- [ ] after auto-submit: `jofotaraStatus: "VALIDATED"`
- [ ] returnable now `1` (the view subtracted the returned unit)
- [ ] over-returning (returnQuantity 5) → `400`

---

## 4. Monthly tax report

```bash
curl -s "http://localhost:3000/api/v1/tax/report?year=2026&month=5" -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] `totalSalesTaxFils: 80000`, `totalReturnsTaxFils: -40000`, `netOutputTaxFils: 40000`
- [ ] `invoiceCount: 1`, `creditNoteCount: 1`

```bash
curl -s "http://localhost:3000/api/v1/tax/ledger" -H "Authorization: Bearer $TOKEN" | jq '.data | map({entryType,documentNumber,taxAmount})'
```

- [ ] SALE entry `tax 80000`, RETURN entry `tax -40000`

```bash
curl -s -o tax-report.xlsx -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/v1/tax/report/export?year=2026&month=5"
```

- [ ] valid `.xlsx` downloads

---

## 5. Validator rejects bad invoices

```bash
# clear seller TIN, confirm a new invoice
curl -s -X PATCH http://localhost:3000/api/v1/settings -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"sellerTin":""}' > /dev/null
INV2=$(curl -s -X POST http://localhost:3000/api/v1/invoices -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"repId\":\"$REP\",\"customerId\":\"$CUST\",\"lines\":[{\"productId\":\"$PROD\",\"quantity\":1}]}" | jq -r .data.id)
curl -s -X POST "http://localhost:3000/api/v1/invoices/$INV2/confirm" -H "Authorization: Bearer $TOKEN" > /dev/null
sleep 2
curl -s "http://localhost:3000/api/v1/invoices/$INV2" -H "Authorization: Bearer $TOKEN" | jq '.data.jofotaraStatus'
# restore
curl -s -X PATCH http://localhost:3000/api/v1/settings -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"sellerTin":"123456789"}' > /dev/null
```

- [ ] `jofotaraStatus: "REJECTED"` (missing seller TIN)
- [ ] `jofotara_error_message` mentions `seller.tin`

---

## 6. Manual retry

```bash
curl -s -X POST "http://localhost:3000/api/v1/jofotara/invoices/$INV2/submit" -H "Authorization: Bearer $TOKEN" | jq
```

- [ ] After restoring the TIN, a manual submit returns `{ status: "VALIDATED", ... }`

---

## 7. Permissions

- [ ] credit-note create, jofotara submit, tax report as `viewer` → 403

---

## 8. Unit tests

```bash
docker compose run --rm --no-deps app npm test
```

- [ ] `Tests: 38 passed, 38 total` (incl. tax determinism scenarios)

---

## 9. Going live (when you have real ISTD access)

- [ ] Verify the real JoFotara API URL + contract
- [ ] Set JoFotara `clientId`/`secretKey` via `PATCH /settings/jofotara`
- [ ] Set `JOFOTARA_MOCK=false`, redeploy
- [ ] Submit a sandbox invoice → real QR + registration returned

---

## Done

All green → plan 11 verified (mock mode). This completes plans 00.5–07, 09, 10, 11.
Only plan 08 (AI features) remains.
