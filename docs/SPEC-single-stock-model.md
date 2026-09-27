# SPEC — One stock model, the ERP's, everywhere

Status: implemented (see §9). Applies to cash-van-dashboard (API), FlowVan (handset)
and cash-van-dashboard-frontend (dashboard). The ERP is unchanged — it is the model.

## 1. Why

A salesman's van showed one quantity on the handset, another on the dashboard and a
third in the ERP. The arithmetic was never the problem — every side adds and
subtracts the same way. The problem was *where the number lived* and *how many things
wrote it*:

| | ERP | cash-van before |
|---|---|---|
| Balance | a stored row (`item_stock`), changed with each movement | recomputed on every read by summing every posted voucher line ever (`item_balance` view) |
| History | `stock_movements`, append-only, numbered (`seq`) | none — the vouchers themselves, re-summed |
| Writers | one function, `createStockMovement` | voucher create, `post()`, the ERP mirror, the reconciliation, plus a second table (`van_stock`) |
| Precision | fixed-point ×1000 integers | numeric(14,3) on the server, whole `Int` on the handset (truncated), `Math.round` on the way to the ERP |
| Handset | — | its own running count, overwritten by a server copy on every refresh |

## 2. The model

Two things, and one way to change them. Exactly the ERP's shape:

- **`stock_movements`** — append-only. One signed row per change to one pool:
  `seq` (bigserial), `store_number`, `item_number`, `stock_unit_code` (the pool; `''`
  = base pieces), `qty_milli` (bigint, base pieces ×1000), `txn_id` (the voucher line
  that caused it), `voucher_number`, `reason`, `created_at`.
- **`stock_balance`** — one row per (store, item, pool): `qty_milli`, `last_seq`,
  `updated_at`. Always equal to the sum of that pool's movements.
- **One writer.** In the ERP it is `createStockMovement`. Here it is the database
  function `stock_apply()`: it inserts the movement and updates the balance in the
  same statement's transaction. Nothing else writes either table.

**Quantities are integers ×1000** end to end: `qty_milli` in the database, `Long`
milli on the handset, and the API sends `quantityMilli` beside the old decimal
`quantity`. 2.5 kg is 2500, exactly, everywhere.

**Reservation stays derived.** The ERP keeps `reserved_qty` as a column. Here it is
computed from the open ORDER vouchers, as today — it is the sum of what is open *now*,
not a replay of history, so it cannot drift the way a stock sum did, and a column would
need every fulfil / cancel / void path to maintain it.

**The key stays the cash-van pool** `(store, item_number, stock_unit_code)`, not the
ERP SKU. cash-van runs without an ERP on some installs, and the pool is already 1:1 with
an ERP SKU where there is one (`item_units.erp_sku_code`). The SKU mapping stays where
it is: at the ERP boundary, in the feed and the outbox.

## 3. Server — how every writer is covered

A stock change in cash-van is always "a posted voucher line with a from and/or to
store". Six code paths produce one (voucher create, draft `post()`, the ERP movement
mirror, the reconciliation, the office-invoice sale, stock-request receipt), some
through TypeORM and some through raw inserts. Wiring a function call into each is
exactly how a seventh gets missed.

So the rule is enforced **in the database**, by triggers that call one function:

- `stock_sync_line(line, posted)` — computes what the line *should* have applied
  (`from_store −qty`, `to_store +qty`, only when its header is posted), compares with
  what the ledger says it *has* applied (the net of its movements by `txn_id`), and
  applies only the difference through `stock_apply()`. Idempotent and self-correcting:
  run it twice, nothing moves the second time.
- Triggers:
  - `voucher_transactions` AFTER INSERT, AFTER UPDATE OF (item_qty, from/to store,
    stock_unit_code, item_number, voucher_number), AFTER DELETE → sync that line.
    (`qty_returned` and every other column change nothing — the view ignored them too.)
  - `voucher_headers` AFTER UPDATE OF is_posted → sync every line of the voucher.
  - A deleted header cascades to its lines, whose delete trigger reverses them.

This is the same definition the `item_balance` view had — posted lines, from/to
store, `item_qty` — applied incrementally instead of replayed.

**Switch-over.** The migration backfills one movement per existing posted line side,
builds `stock_balance` from them, keeps the old replay view as `item_balance_replay`,
and redefines `item_balance` over `stock_balance` with identical columns. Every one of
the fourteen readers (van stock, mobile, reports, stock requests, the sale's
stock check, the drift report…) moves to the stored balance with no code change, and
`item_balance_total` is rebuilt on top.

**Verification, permanently.** `GET /stock/ledger/verify` compares `stock_balance` with
`item_balance_replay` pool by pool; the nightly job runs it after the reconciliation and
logs any difference. By construction it is always empty — the check exists so that a
future writer that bypasses the triggers (a `TRUNCATE`, a trigger disabled for a bulk
import) is found the next morning, not at month end.

**ERP boundary.** Quantities pushed as stock adjustments and transfers are sent exact
to three places, not `Math.round`ed — the ERP accepts decimals there.

## 4. Handset — the same model, offline

The handset keeps the same two things in Room:

- **the server's balance**, as last received (`products.van_stock_milli`,
  `product_units.van_stock_milli`), and
- **`local_stock_movements`** — what this device did since, one row per document per
  pool (`doc_id`, `pool_kind` B/V, `pool_id`, `qty_milli`, `absorbed_at`).

**One writer on the device:** `LocalStockLedger.record(docId, moves)` — inserts the
movement rows and adjusts the shown balance in one Room transaction. Every document
that moves the van (sale with its gifts and bonus lines, return, approved sale, approved
return) goes through it. What it records is exactly what the sale deducted, stored, not
recomputed later.

**Shown stock = server balance + Σ this device's movements the server has not
absorbed.** Offline, nothing changes: sales record movements, the balance moves, the
rep sees it immediately.

**Absorption is exact, not guessed.** On refresh the handset sends the documents it
still holds unabsorbed movements for — `POST /reps/:repId/van-stock/snapshot`
`{ pending: [{ ref, number? }] }` — and the server answers, *in the same REPEATABLE READ
transaction as the balance it returns*, which of them that balance already contains:

- `ref` is the handset's clientRef; it is applied when its inbox row's assigned voucher
  is posted.
- `number` is sent only for documents whose number came from the server (approved
  requests, and synced documents after renumbering); it is applied when that voucher is
  posted.

One snapshot, one answer about it: no clock comparison, no seq race. The handset marks
those documents absorbed and recomputes every pool in one Room transaction — pools the
server no longer lists are zero. A document the server rejected is never absorbed, so
the device keeps it off the van, which is where the goods are.

**Backfill and crash safety.** A confirmed sale/return with no movement rows (saved by
an older build, or a crash between saving the document and recording its movement) is
derived once from its stored lines and recorded — only for documents unsynced or synced
in the last 48 hours; anything older is already in the server's balance.

**Old servers.** If the snapshot endpoint answers 404, the handset uses the old
`GET …/van-stock` and treats unsynced documents as unabsorbed (the previous rule).
**Old handsets** keep using `GET …/van-stock`, unchanged apart from the extra
`quantityMilli` field.

## 5. Dashboard

Reads the stored balance through the API as before — it has no stock arithmetic of its
own. Adds the **stock card** (كرت الصنف): from the stock balances report, a pool opens
its movement history — date, document, kind, in, out, running balance — from
`GET /stock/movements?store=&itemNumber=&stockUnitCode=`. Every number on the balances
screen can now be traced to the documents that made it.

## 6. Test vectors

`docs/stock-vectors.json` (identical copy in FlowVan) lists document sequences and the
balance each pool must end at: sale, return, carton, variant, bonus line of a variant,
offer gift, transfer both ends, fraction, draft→post, unpost, line edit, delete. The
API runs them through the real triggers (integration spec); the handset runs them
through `LocalStockLedger`. A change that makes one side compute differently fails its
own suite.

## 7. What this does not change

The lost-message fixes shipped before this (lossless ERP feed, outages no longer
dead-letter, reconciliation holding back stores with unsent documents) are the
foundation and stay. Reservation arithmetic, the ERP feed's shape, the outbox, and the
legacy `van_stock` table for reps with no van warehouse are untouched; the last is
listed by `deploy/stock-sync-check.sql` §6 and goes once every rep has a van.

## 8. Rollout

1. API: migration `StockLedger` (backfill + view switch in one transaction). Verify
   endpoint must be empty right after.
2. Handset: Room v27 migration converts stock to milli and adds the ledger table.
   Works against an old server (fallback) and a new one.
3. Dashboard: stock card.

Rollback: the migration's `down` restores the replay view as `item_balance` and drops
the triggers, functions and tables.

## 9. Implementation map

| Piece | Where |
|---|---|
| Tables, functions, triggers, backfill, view switch | `src/database/migrations/1727800000000-StockLedger.ts` |
| Entities (read-only in app code) | `src/modules/stock-ledger/entities/*` |
| Verify, stock card, snapshot | `src/modules/stock-ledger/stock-ledger.service.ts` |
| Routes | `src/modules/stock-ledger/stock-ledger.controller.ts`, `POST /reps/:repId/van-stock/snapshot` |
| Exact quantities to the ERP | `src/modules/erp-sync/erp-outbox.service.ts` |
| Trigger + vector tests | `src/modules/stock-ledger/stock-ledger.integration.spec.ts` |
| Handset ledger | FlowVan `core/domain/.../ledger/LocalStockLedger.kt`, `core/database/.../dao/StockLedgerDao.kt` |
| Handset rule | FlowVan `core/domain/.../ledger/StockMoves.kt` (`stockMovesOf`) — the check before a sale and the movement after it |
| Handset migration | FlowVan `core/database/.../db/Migration26To27.kt` (by hand: an AutoMigration rename would rebuild `products` and cascade-delete its units) |
| Handset tests | FlowVan `core/domain/src/commonTest/.../ledger/StockMovesTest.kt`, `core/domain/src/androidUnitTest/.../ledger/StockVectorsTest.kt` |
| Stock card | frontend `src/features/stock-balances/StockCardDrawer.tsx` |
