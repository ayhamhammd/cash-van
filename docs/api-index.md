# VanFlow API — endpoint index

Compact list of every endpoint for AI context. Full spec: [openapi.yaml](openapi.yaml) / [openapi.json](openapi.json).

- Success: `{ success, data, timestamp }`  · Error: `{ statusCode, message, error, path, timestamp }` (400/401/403/404/409/500)
- All except `POST /api/v1/auth/login` require `Authorization: Bearer <JWT>`

## audit-log

- `GET /api/v1/audit-log` — Query audit log
- `GET /api/v1/audit-log/{entity}/{entityId}` — Record change history

## auth

- `POST /api/v1/auth/login` — Log in
- `GET /api/v1/auth/me` — Current user

## cheques

- `GET /api/v1/cheques` — List cheques
- `POST /api/v1/cheques/{id}/mark-bounced` — Mark cheque bounced
- `POST /api/v1/cheques/{id}/mark-cleared` — Mark cheque cleared
- `POST /api/v1/cheques/{id}/reconcile` — Reconcile cheque
- `GET /api/v1/cheques/export/bank` — Export bank clearing CSV
- `GET /api/v1/cheques/reconcile/queue` — Reconciliation queue

## collections

- `GET /api/v1/collections` — List collections
- `POST /api/v1/collections` — Record collection
- `GET /api/v1/collections/{id}` — Get collection
- `POST /api/v1/collections/{id}/confirm` — Confirm collection
- `GET /api/v1/collections/aging` — Cheque aging buckets
- `POST /api/v1/collections/batch-deposit` — Batch deposit
- `GET /api/v1/collections/summary` — Daily collection summary

## credit-notes

- `GET /api/v1/credit-notes` — List credit notes
- `POST /api/v1/credit-notes` — Create credit note
- `GET /api/v1/credit-notes/{id}` — Get credit note

## customers

- `GET /api/v1/customers` — List customers
- `POST /api/v1/customers` — Create customer
- `GET /api/v1/customers/{id}` — Get customer
- `PATCH /api/v1/customers/{id}` — Update customer
- `DELETE /api/v1/customers/{id}` — Delete customer
- `GET /api/v1/customers/{id}/insights` — Customer AI insights
- `POST /api/v1/customers/{id}/reassign` — Reassign customer
- `POST /api/v1/customers/{id}/refresh-ai` — Refresh AI profile
- `GET /api/v1/customers/{id}/visits` — List customer visits
- `POST /api/v1/customers/{id}/visits` — Log customer visit
- `POST /api/v1/customers/import` — Bulk import customers

## health

- `GET /api/v1/health` — Health check

## invoices

- `GET /api/v1/invoices` — List invoices
- `POST /api/v1/invoices` — Create invoice
- `GET /api/v1/invoices/{id}` — Get invoice
- `PATCH /api/v1/invoices/{id}` — Edit draft invoice
- `POST /api/v1/invoices/{id}/approve` — Approve invoice
- `GET /api/v1/invoices/{id}/audit` — Invoice audit timeline
- `POST /api/v1/invoices/{id}/cancel` — Cancel invoice
- `POST /api/v1/invoices/{id}/confirm` — Confirm invoice
- `POST /api/v1/invoices/{id}/override` — Override invoice discount
- `POST /api/v1/invoices/{id}/reject` — Reject invoice
- `GET /api/v1/invoices/export` — Export invoices to XLSX

## items

- `POST /api/v1/items` — Create item
- `GET /api/v1/items` — List items
- `GET /api/v1/items/{id}` — Get item
- `PATCH /api/v1/items/{id}` — Update item
- `DELETE /api/v1/items/{id}` — Delete item
- `GET /api/v1/items/{itemNumber}/switches` — List unit switches
- `GET /api/v1/items/balance/list` — List item balances
- `GET /api/v1/items/barcode/{barcode}` — Find item by barcode
- `POST /api/v1/items/expiry` — Create expiry record
- `DELETE /api/v1/items/expiry/{id}` — Delete expiry record
- `GET /api/v1/items/expiry/before/{date}` — Expiring before date
- `GET /api/v1/items/expiry/list` — List expiry records
- `POST /api/v1/items/switches` — Create unit switch
- `DELETE /api/v1/items/switches/{id}` — Delete unit switch
- `GET /api/v1/items/switches/barcode/{barcode}` — Find unit switch by barcode

## jofotara

- `GET /api/v1/invoices/{id}/credit-notes` — Credit notes for invoice
- `GET /api/v1/invoices/{id}/returnable` — Returnable quantities
- `POST /api/v1/jofotara/credit-notes/{id}/submit` — Submit credit note to ISTD
- `POST /api/v1/jofotara/invoices/{id}/submit` — Submit invoice to ISTD
- `GET /api/v1/jofotara/submissions/{documentId}/log` — ISTD submission log

## journey-plan

- `GET /api/v1/reps/{repId}/journey-plan` — List a rep's journey plan
- `PUT /api/v1/reps/{repId}/journey-plan/{customerId}` — Set an outlet schedule
- `DELETE /api/v1/reps/{repId}/journey-plan/{customerId}` — Remove an outlet schedule
- `POST /api/v1/reps/{repId}/journey-plan/bulk` — Replace whole journey plan

## mobile

- `GET /api/v1/mobile/company/meta` — Get company metadata
- `GET /api/v1/mobile/itemBalance` — Get item balance
- `GET /api/v1/mobile/items/{itemCode}` — Get item
- `GET /api/v1/mobile/salesman/{salesmanCode}` — Get salesman

## notification-rules

- `GET /api/v1/notification-rules` — List notification rules
- `POST /api/v1/notification-rules` — Create notification rule
- `PATCH /api/v1/notification-rules/{id}` — Update notification rule
- `DELETE /api/v1/notification-rules/{id}` — Delete notification rule
- `POST /api/v1/notification-rules/{id}/test` — Test notification rule

## price-rules

- `GET /api/v1/price-rules` — List price rules
- `POST /api/v1/price-rules` — Create price rule
- `PATCH /api/v1/price-rules/{id}` — Update price rule
- `DELETE /api/v1/price-rules/{id}` — Delete price rule

## product-categories

- `GET /api/v1/product-categories` — Category tree
- `POST /api/v1/product-categories` — Create category
- `PATCH /api/v1/product-categories/{id}` — Update category
- `DELETE /api/v1/product-categories/{id}` — Delete category

## products

- `GET /api/v1/products` — List products
- `POST /api/v1/products` — Create product
- `GET /api/v1/products/{id}` — Get product
- `PATCH /api/v1/products/{id}` — Update product
- `DELETE /api/v1/products/{id}` — Delete product
- `POST /api/v1/products/{id}/quote` — Quote price

## regions

- `GET /api/v1/regions` — List regions
- `POST /api/v1/regions` — Create region
- `GET /api/v1/regions/{id}` — Get region
- `PATCH /api/v1/regions/{id}` — Update region
- `DELETE /api/v1/regions/{id}` — Delete region
- `GET /api/v1/regions/containing` — Region containing a point

## reps

- `GET /api/v1/reps` — List reps
- `POST /api/v1/reps` — Create rep
- `GET /api/v1/reps/{id}` — Get rep
- `PATCH /api/v1/reps/{id}` — Update rep
- `DELETE /api/v1/reps/{id}` — Delete rep
- `GET /api/v1/reps/{id}/kpis` — Rep KPIs
- `GET /api/v1/reps/me` — Get my rep profile
- `GET /api/v1/reps/me/kpis` — My KPIs

## reps-locations

- `POST /api/v1/reps/{id}/location` — Record GPS ping
- `POST /api/v1/reps/{id}/location/bulk` — Bulk record GPS pings
- `GET /api/v1/reps/{id}/locations` — Replay GPS trail
- `GET /api/v1/reps/{id}/locations.geojson` — GPS trail as GeoJSON
- `GET /api/v1/reps/locations/latest` — Latest ping per rep

## routes

- `GET /api/v1/routes` — List route plans
- `POST /api/v1/routes` — Create route plan
- `GET /api/v1/routes/{id}` — Get route plan
- `POST /api/v1/routes/{id}/accept` — Accept route plan
- `PATCH /api/v1/routes/{id}/stops/reorder` — Reorder stops
- `GET /api/v1/routes/compliance` — Route compliance
- `POST /api/v1/routes/generate` — Generate routes
- `GET /api/v1/routes/overdue` — Overdue (missed) outlets
- `POST /api/v1/routes/stops/{stopId}/skip` — Mark stop skipped
- `POST /api/v1/routes/stops/{stopId}/visit` — Mark stop visited

## settings

- `GET /api/v1/settings` — Get app settings
- `PATCH /api/v1/settings` — Update app settings
- `PATCH /api/v1/settings/jofotara` — Set JoFotara credentials

## tax

- `GET /api/v1/tax/ledger` — List ledger entries
- `GET /api/v1/tax/report` — Monthly tax report
- `GET /api/v1/tax/report/export` — Export monthly report (XLSX)

## users

- `POST /api/v1/users` — Create user
- `GET /api/v1/users` — List users
- `GET /api/v1/users/{id}` — Get user
- `PATCH /api/v1/users/{id}` — Update user
- `DELETE /api/v1/users/{id}` — Delete user
- `PATCH /api/v1/users/{id}/password` — Change password

## van-stock

- `GET /api/v1/reps/{repId}/van-stock` — Get van stock
- `POST /api/v1/reps/{repId}/van-stock/load` — Load van stock
- `POST /api/v1/reps/{repId}/van-stock/return` — Return van stock

## vendors

- `POST /api/v1/vendors` — Create vendor
- `GET /api/v1/vendors` — List vendors
- `GET /api/v1/vendors/{id}` — Get vendor
- `PATCH /api/v1/vendors/{id}` — Update vendor
- `DELETE /api/v1/vendors/{id}` — Delete vendor

## vouchers

- `POST /api/v1/vouchers` — Create voucher
- `GET /api/v1/vouchers` — List vouchers
- `GET /api/v1/vouchers/{id}` — Get voucher
- `PATCH /api/v1/vouchers/{id}` — Update voucher
- `DELETE /api/v1/vouchers/{id}` — Delete voucher
- `PATCH /api/v1/vouchers/{id}/post` — Post voucher
- `POST /api/v1/vouchers/cheques` — Create cheque
- `DELETE /api/v1/vouchers/cheques/{id}` — Delete cheque
- `GET /api/v1/vouchers/cheques/list` — List cheques
- `GET /api/v1/vouchers/kinds` — List transaction kinds
- `POST /api/v1/vouchers/kinds` — Create transaction kind

## warehouses

- `POST /api/v1/warehouses` — Create warehouse
- `GET /api/v1/warehouses` — List warehouses
- `GET /api/v1/warehouses/{id}` — Get warehouse
- `PATCH /api/v1/warehouses/{id}` — Update warehouse
- `DELETE /api/v1/warehouses/{id}` — Delete warehouse

## year-config

- `POST /api/v1/year-config` — Create year config
- `GET /api/v1/year-config` — List year configs
- `PATCH /api/v1/year-config/{id}` — Update year config
- `DELETE /api/v1/year-config/{id}` — Delete year config
- `GET /api/v1/year-config/year/{year}` — List by year
