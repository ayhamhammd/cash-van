# Van stock out of step with the ERP — check and recover

For a server (dev stage, Ferdous 94, Tal3at 77) where a salesman's van shows a
different quantity than the ERP, or vouchers seem to go missing between the
handset, cash-van and the ERP.

The ERP is the book of record for stock. After this release cash-van converges
to it on its own (lossless movement feed + nightly reconciliation), but that only
stops **new** drift. Documents already dropped have to be put back once, in the
order below — the order matters.

All API calls are admin, against `https://<host>/api/v1`.

## 1. Measure first (read-only)

```bash
docker exec -i <cashvan-db> psql -U cashvan -d <db> -P pager=off < stock-sync-check.sql
```

and `GET /erp/sync/drift` — cash-van vs ERP, pool by pool, per van.

Keep both outputs: they are the "before" and they say which of the steps below
this server needs.

| check section | what it means | step |
|---|---|---|
| 2 — outbox `dead_letter` | a voucher the ERP never got; stock left the van here only | 3a |
| 4 — approved drafts | a sale the handset committed and the server never posted | 3b |
| 1 — inbox `rejected` / `dead_letter` | a handset sale neither side recorded | 3d |
| 5 — `last_skipped > 0` | ERP movements stepped over (the lost loads) | 3c fixes them |

## 2. Deploy

Client images do NOT run migrations on start (`migrationsRun: false`; the entrypoint
only starts `node dist/main.js`). Every step below is by hand, on each server.

0. Before touching anything, set `ERP_STOCK_RECONCILE_NIGHTLY=off` in the API's
   environment. Otherwise the first night corrects every van to the ERP unattended,
   including all the drift accumulated so far — that first correction should be a
   dry run a person has read (§3c), not a surprise the next morning.
1. Back up the database (see UPGRADE-94.142.51.91.md §1).
   Size the backfill, read-only:
   `SELECT COUNT(*) FROM voucher_transactions vt JOIN voucher_headers vh ON vh.voucher_number = vt.voucher_number AND vh.is_posted;`
   The StockLedger migration writes about one movement per line and holds the
   voucher tables for its duration — run it after hours, when no van is syncing
   (an upload that arrives meanwhile waits, then goes through).
   List what is pending on THIS server — it may be more than these two:
   `docker exec cashvan-api npx typeorm migration:show -d dist/database/data-source.js`
2. API image, then **run migrations** — this release adds `LosslessMovementFeed` and
   `StockLedger` (docs/SPEC-single-stock-model.md). The second builds the stored
   balance from every posted voucher; on a large database give it a minute. Then
   `GET /stock/ledger/verify` must return no differences — if it lists any, stop
   and send them to development before going further.
   Rollback, if verify is not empty or anything misbehaves: restore the previous
   image and revert the two migrations, newest first —
   `docker exec cashvan-api npx typeorm migration:revert -d dist/database/data-source.js` (twice).
   StockLedger's `down` puts the old view back; nothing else depends on it.
3. The new APK (Room v27). Until a handset updates, its old build still copies the
   server's figure over its own on every refresh, so an offline sale shows as unsold
   until it uploads. Raise `minVersionCode` once the fleet has it.

## 3. Recover, in this order

**a. Resend what the ERP never received.**
`POST /erp/outbox/dead-letters/retry` → wait for the queue to drain
(`GET /erp/outbox?status=pending` empty), re-run section 2. Safe to repeat — every
push is idempotent, and a document the ERP already has counts as sent. Whatever
dead-letters again is a real refusal: read `error` (usually an item or customer the
ERP does not know), fix that, then `POST /erp/outbox/:id/retry`.

**b. Approved drafts (section 4).** Do not bulk-post these: they were created
without a van store, so posting them as they are exports the sale without moving
cash-van's stock. Send the list to development for one fix script.

**c. Reconcile to the ERP.** Only after (a) — a store with anything still queued is
skipped anyway, but resending first lets the correction cover it.
`POST /erp/sync/reconcile-stock?dryRun=1`, read `applied` / `skipped`, then the same
without `dryRun`. Once that first correction is done and looks right, remove
`ERP_STOCK_RECONCILE_NIGHTLY=off` (step 0) so it runs every night after the heavy sync.

**d. Handset documents that never landed (section 1).** Last, because a stock
shortfall rejection passes once (c) has put the van right. `GET /sync/inbox?status=dead_letter`
and `?status=rejected`; fix a payload with `PATCH /sync/inbox/:id` when the reason
says so, then `POST /sync/inbox/:id/retry`.

## 4. Measure again

Re-run `stock-sync-check.sql`, `GET /erp/sync/drift` and `GET /stock/ledger/verify`.
Sections 1, 2 and 4 should be empty; drift should be zero except for stores the
reconciliation reported as skipped, each with its reason; the ledger verify should
list nothing.

Any balance on the stock balances screen now opens its stock card (كرت الصنف) —
every movement behind it — which is where to start when a figure is questioned.
