# End-to-end, across the whole suite

Two scripts. Both talk to a running `docker-compose.suite.yml` over HTTP and,
where it matters, read the ERP's own database — because the only honest way to
prove a sync worked is to look at the far side.

```bash
node scripts/e2e/suite.mjs      # 7CRM → both products: keys, provisioning, service keys, staff
node scripts/e2e/erp-sync.mjs   # VanFlow ↔ ERP with real catalogue data in both directions
```

Each run creates its own company and deletes any leftover of the same code
first, so they are safe to run repeatedly. Override the code with `CODE=…` to
run two at once.

## Why the ordering in `erp-sync.mjs` looks odd

The ERP is provisioned and seeded BEFORE VanFlow. Pairing rotates the ERP link
key, so a key minted before VanFlow arrives is dead by the time it would be used
afterwards — seeding late leaves the harness holding a retired key and looking
like a sync failure that is really a test bug.

## What they caught

Kept here because each one was silent in production and none of it showed up in
a unit test:

- `app_secrets` had no `version` column, so every read of a company's
  applications failed with a bare "Database query failed".
- The link key the CRM mints had `organization:read` but not `:write`, so
  VanFlow's push of the company's own details 403'd on every sync.
- A CRM-provisioned ERP organisation had no tax rate, and a product cannot be
  created without one — so the catalogue was permanently empty and there was
  nothing for the sync to move.
- `POST /van-stock-requests` did not exist in the ERP. Every approved van stock
  request burned six retries against a 404 and dead-lettered.
- Every `@OnEvent` mirror in VanFlow ran after its HTTP request had committed,
  on a released connection with no company bound — so a customer created in the
  dashboard never reached the ERP, and the queue that exists to catch that could
  not write either.
- `stock_transfer_items` was inserted without `org_id` in all three places that
  create a transfer, so no stock transfer in the ERP could be saved at all.
