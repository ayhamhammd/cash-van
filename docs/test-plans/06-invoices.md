# Test plan — Plan 06 · Sales Invoices & Approval

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

Seed a rep, customer, and two products (taxable + exempt):

```bash
REP=$(curl -s -X POST http://localhost:3000/api/v1/reps -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"nameAr":"Inv Rep"}' | jq -r .data.id)
CUST=$(curl -s -X POST http://localhost:3000/api/v1/customers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"customerNumber":"INVC","customerName":"Inv Cust"}' | jq -r .data.id)
TAX=$(curl -s -X POST http://localhost:3000/api/v1/products -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"itemNumber":"TAX1","barcode":"B-TAX1","name":"Taxable","price":250000,"taxType":"TAXABLE","taxCategory":"S","taxRate":0.16}' | jq -r .data.id)
EXM=$(curl -s -X POST http://localhost:3000/api/v1/products -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"itemNumber":"EXM1","barcode":"B-EXM1","name":"Exempt","price":80000,"taxType":"EXEMPT","taxCategory":"E","taxRate":0}' | jq -r .data.id)
```

---

## 1. Migration applied

```bash
docker compose run --rm app npm run migration:show | grep AddInvoices
docker compose exec db psql -U cashvan -d cashvan -c "\d invoices" | grep -E "status|grand_total|jofotara"
docker compose exec db psql -U cashvan -d cashvan -c "SELECT 1 FROM pg_sequences WHERE sequencename='invoice_number_seq';"
docker compose exec db psql -U cashvan -d cashvan -c "SELECT column_name FROM information_schema.columns WHERE table_name='voucher_headers' AND column_name='invoice_id';"
```

- [ ] `[X] AddInvoicesAndApprovals...`
- [ ] `invoices` has status/grand_total/jofotara columns
- [ ] `invoice_number_seq` exists
- [ ] `voucher_headers.invoice_id` bridge column exists

---

## 2. Create draft — tax math

```bash
INV=$(curl -s -X POST http://localhost:3000/api/v1/invoices -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"repId\":\"$REP\",\"customerId\":\"$CUST\",\"lines\":[{\"productId\":\"$TAX\",\"quantity\":2},{\"productId\":\"$EXM\",\"quantity\":1}]}")
echo $INV | jq '.data | {invoiceNumber,status,subtotal,netTaxable,taxOnTaxable,netExempt,totalTax,grandTotal}'
INV_ID=$(echo $INV | jq -r .data.id)
```

- [ ] `invoiceNumber` = `INV-<year>-000001` (or next sequential)
- [ ] `status: "draft"`
- [ ] `subtotal: 580000`, `netTaxable: 500000`, `taxOnTaxable: 80000`, `netExempt: 80000`, `totalTax: 80000`, `grandTotal: 660000`

---

## 3. Confirm

```bash
curl -s -X POST "http://localhost:3000/api/v1/invoices/$INV_ID/confirm" -H "Authorization: Bearer $TOKEN" \
  | jq '.data | {status,confirmedAt,jofotaraUuid,jofotaraStatus}'
```

- [ ] `status: "confirmed"`, `confirmedAt` set, `jofotaraUuid` set, `jofotaraStatus: "PENDING"`

---

## 4. Edit-after-confirm guard

```bash
curl -i -s -X PATCH "http://localhost:3000/api/v1/invoices/$INV_ID" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"note":"x"}' | head -1
```

- [ ] HTTP `409` ("Only draft invoices can be edited")

---

## 5. Approve + audit

```bash
curl -s -X POST "http://localhost:3000/api/v1/invoices/$INV_ID/approve" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"reason":"looks good"}' | jq .data.status
curl -s "http://localhost:3000/api/v1/invoices/$INV_ID/audit" -H "Authorization: Bearer $TOKEN" \
  | jq '.data | map({action,reason})'
```

- [ ] approve → `"confirmed"`
- [ ] audit shows `submitted` then `approved` (with reason), each with a non-null `actorId`

---

## 6. Override (recompute)

```bash
curl -s -X POST "http://localhost:3000/api/v1/invoices/$INV_ID/override" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"invoiceDiscountAmount":50000,"reason":"goodwill"}' \
  | jq '.data | {invoiceDiscountAmount,netTaxable,taxOnTaxable,grandTotal}'
```

- [ ] `invoiceDiscountAmount: 50000`
- [ ] `netTaxable: 456897`, `taxOnTaxable: 73104`, `grandTotal: 603104`
      (50000 distributed proportionally: 43103 to taxable, 6897 to exempt)
- [ ] audit now includes an `override` row

---

## 7. Reject returns to draft

```bash
INV2=$(curl -s -X POST http://localhost:3000/api/v1/invoices -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"repId\":\"$REP\",\"customerId\":\"$CUST\",\"lines\":[{\"productId\":\"$TAX\",\"quantity\":1}]}" | jq -r .data.id)
curl -s -X POST "http://localhost:3000/api/v1/invoices/$INV2/confirm" -H "Authorization: Bearer $TOKEN" > /dev/null
curl -s -X POST "http://localhost:3000/api/v1/invoices/$INV2/reject" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"reason":"wrong customer"}' | jq .data.status
```

- [ ] status → `"draft"` (rep can fix and re-confirm)

---

## 8. XLSX export

```bash
curl -s -o invoices.xlsx -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/v1/invoices/export"
file invoices.xlsx     # or check first 2 bytes are "PK"
```

- [ ] A valid `.xlsx` downloads (opens in Excel/LibreOffice)
- [ ] One row per line item, amounts in JOD, grand total on the first line per invoice

---

## 9. Filters

```bash
curl -s "http://localhost:3000/api/v1/invoices?status=confirmed" -H "Authorization: Bearer $TOKEN" | jq .data.total
curl -s "http://localhost:3000/api/v1/invoices?repId=$REP" -H "Authorization: Bearer $TOKEN" | jq .data.total
```

- [ ] Status + rep filters narrow results correctly

---

## 10. Permissions

- [ ] `cancel` / `approve` / `reject` / `override` / `export` as `viewer` → 403
- [ ] `create` / `confirm` allowed for any authenticated user (rep actions)

---

## 11. Unit tests

```bash
docker compose run --rm --no-deps app npm test
```

- [ ] `Tests: 35 passed, 35 total` (6 invoice-calculator scenarios incl. mixed types + invoice discount)

---

## 12. Swagger

Open `http://localhost:3000/docs`:

- [ ] `invoices` tag shows create/confirm/approve/reject/override/cancel/audit/export

---

## Done

All green → plan 06 verified. Next: plan 07 (Collections) or plan 11 (JoFotara, which subscribes to `invoice.confirmed`).
