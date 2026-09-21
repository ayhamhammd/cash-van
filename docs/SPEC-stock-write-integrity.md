# SPEC — Stock write integrity: no lost updates, no silent clamping

Two concurrent documents touching the same van pool currently lose one of the two
deductions, and the code then hides the discrepancy instead of refusing it. This closes both.

Scope: `van_stock`, `damaged_stock`, the availability check in `VouchersService.createUnchecked`,
and the `item_balance` view. Companion: `SPEC-erp-authoritative-stock.md` (which store is the
book of record), `SPEC-sync-intake-contract.md` (why concurrent van writes are now routine).

---

## 1. What exists today (verified 2026-09-21)

### 1.1 The write is a read-modify-write with no lock

`VouchersService.applyLineToVan` (`src/modules/vouchers/vouchers.service.ts:1244`):

    const vs = (await repo.findOne({ where: { repId, productId, stockUnitCode } }))
            ?? repo.create({ …, quantity: 0, reserved: 0 });

    if (effect === 'in')      vs.quantity += qty;
    else if (effect === 'out') vs.quantity = Math.max(0, vs.quantity - qty);
    else if (effect === 'reserve') vs.reserved += qty;

    await repo.save(vs);

`applyLineToDamaged` (`:1281`) has the identical shape.

The `EntityManager` is the voucher's transaction, so the write is atomic *with the rest of
the voucher*. It is not serialised against **another** voucher. Under Postgres's default READ
COMMITTED, two transactions both read `quantity = 10`, one writes `7`, the other writes `6`,
and the second commit wins. Three pieces have left the van and the ledger says four have.

This is not theoretical for this system. A handset that has been offline for hours uploads a
batch, and `SyncInboxDrainService` (`SPEC-sync-intake-contract.md` §4.3) promotes up to 20
documents per tick — same rep, same items, back to back, and soon on more than one instance.

### 1.2 The clamp hides it

`Math.max(0, vs.quantity - qty)` at `:1274`. When the subtraction would go negative the row
silently becomes `0`. So the *only* signal that stock accounting has broken is erased at the
moment it occurs. Every diagnosis afterwards is a physical count against a number that was
quietly rounded up.

`vs.quantity` is `integer` (`van-stock.entity.ts:35`) with no CHECK constraint, so the
database will not catch it either.

### 1.3 The availability check reads a different table than the write

The guard at `:953` calls `stockBalance` (`:1617`), which reads the **`item_balance` view**:

    SELECT COALESCE(qty, 0) FROM item_balance
     WHERE item_number = $1 AND stock_unit_code = $2 AND stock_number = $3

`item_balance` is a view that aggregates `SUM(delta)` over every posted
`voucher_transactions` row ever written (`1717400000000-VoucherStoreTransfer.ts:69`). So:

- The check reads a **derived aggregate**; the write mutates a **materialised counter**
  (`van_stock`). Nothing keeps the two equal, and nothing reconciles them.
- A view cannot be locked. `SELECT … FOR UPDATE` against `item_balance` is not available, so
  the check is structurally a dirty read no matter what isolation level the caller picks.
- Cost grows with history. Every stock check on every line of every sale re-aggregates the
  whole transaction table for that item.

So there are two defects wearing one coat: **the write races**, and **the check cannot be
made to serialise against it**.

---

## 2. What changes

| | today | after |
|---|---|---|
| `van_stock` write | read → mutate → save | **`INSERT … ON CONFLICT DO UPDATE` with a guarded `WHERE`** |
| Negative result | clamped to 0, silently | **`InsufficientStockError`, document rejected** |
| DB guarantee | none | **`CHECK (quantity >= 0)`, `CHECK (reserved >= 0)`** |
| Availability check source | `item_balance` view | **`van_stock` row, locked** — for van stores |
| Serialisation | none | the `van_stock` row is the lock for its pool |
| Reconciliation | manual ERP recalculate | **scheduled drift check with an alarm** (§5) |

The design choice worth stating plainly: **`van_stock` becomes the single lockable authority
for van pools.** It is already per `(rep_id, product_id, stock_unit_code)` with a unique
constraint (`uq_van_stock_rep_product_unit`), which makes it exactly the right lock
granularity — two reps, or two different items, never contend.

`item_balance` stays, for reporting and for non-van stores. It stops being the thing a sale
is validated against.

---

## 3. Schema

`src/database/migrations/1727100000000-StockWriteIntegrity.ts`

    -- Repair before constraining. Any row already negative is a symptom of §1.2
    -- and must be recorded, not silently lifted to zero a second time.
    CREATE TABLE stock_integrity_findings (
      id           BIGSERIAL PRIMARY KEY,
      found_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      rep_id       UUID        NOT NULL,
      product_id   UUID        NOT NULL,
      stock_unit_code TEXT     NOT NULL DEFAULT '',
      van_stock_qty   NUMERIC(14,3),
      ledger_qty      NUMERIC(14,3),
      erp_qty         NUMERIC(14,3),
      kind         TEXT        NOT NULL,     -- 'negative' | 'drift'
      resolved_at  TIMESTAMPTZ
    );

    INSERT INTO stock_integrity_findings (rep_id, product_id, stock_unit_code,
                                         van_stock_qty, kind)
    SELECT rep_id, product_id, stock_unit_code, quantity, 'negative'
      FROM van_stock WHERE quantity < 0 OR reserved < 0;

    UPDATE van_stock SET quantity = 0 WHERE quantity < 0;
    UPDATE van_stock SET reserved = 0 WHERE reserved < 0;

    ALTER TABLE van_stock
      ADD CONSTRAINT chk_van_stock_qty_nonneg      CHECK (quantity >= 0),
      ADD CONSTRAINT chk_van_stock_reserved_nonneg CHECK (reserved >= 0);

    ALTER TABLE damaged_stock
      ADD CONSTRAINT chk_damaged_stock_qty_nonneg  CHECK (quantity >= 0);

    -- The lock/lookup path. The unique constraint already covers the tuple; this
    -- is the covering index for the drift job's per-rep sweep.
    CREATE INDEX IF NOT EXISTS idx_van_stock_rep_product_unit
      ON van_stock (rep_id, product_id, stock_unit_code);

The CHECK constraints are the real deliverable of this migration. Once they exist, a lost
update cannot silently produce a wrong-but-plausible number — the worst case becomes a
refused transaction, which is a bug report instead of an inventory loss.

---

## 4. Backend

### 4.1 `applyLineToVan` becomes one atomic statement

    private async applyLineToVan(em, repId, line, effect): Promise<void> {
      const qty = Math.round(Number(line.itemQty) || 0);
      if (qty <= 0) return;
      const delta = effect === 'in' ? qty : effect === 'out' ? -qty : 0;

      const res = await em.query(
        `INSERT INTO van_stock (rep_id, product_id, stock_unit_code,
                                quantity, reserved, loaded_at, snapshot_at)
         VALUES ($1, $2, $3, GREATEST($4, 0), $5, $6, now())
         ON CONFLICT (rep_id, product_id, stock_unit_code) DO UPDATE
            SET quantity   = van_stock.quantity + $4,
                reserved   = van_stock.reserved + $5,
                loaded_at  = COALESCE($6, van_stock.loaded_at),
                snapshot_at = now()
          WHERE van_stock.quantity + $4 >= 0
            AND van_stock.reserved + $5 >= 0
         RETURNING quantity, reserved`,
        [repId, product.id, stockUnitCode, delta, reserveDelta, loadedAt]);

      if (res.length === 0) {
        throw new InsufficientStockError(line.itemNumber, stockUnitCode, qty);
      }
    }

Three properties, each deliberate:

- **`ON CONFLICT DO UPDATE` takes a row lock on the existing row** for the remainder of the
  transaction. The second concurrent voucher for that pool blocks until the first commits,
  then applies its delta to the *committed* value. No lost update, at any isolation level.
- **`quantity = van_stock.quantity + $4`** — a relative delta computed by the database, never
  a value computed in Node from a stale read.
- **The `WHERE` guard turns overdraft into zero affected rows**, which `res.length === 0`
  turns into a thrown error. This replaces the `Math.max(0, …)` clamp: the document is
  refused rather than the ledger being bent to fit it.

The insert branch keeps `GREATEST($4, 0)` only so a brand-new row from an `out` cannot be
created negative; that path means the rep sold from a pool with no row at all, which §4.2's
check rejects first.

`applyLineToDamaged` (`:1281`) gets the same treatment. It only ever accrues, so it needs no
guard — but it needs the same atomic upsert, because two returns of the same item in one
batch lose one of the two increments today.

### 4.2 The availability check reads and locks `van_stock`

Replace `stockBalance` for **van stores** with a locking read inside the voucher transaction:

    SELECT quantity - reserved AS available
      FROM van_stock
     WHERE rep_id = $1 AND product_id = $2 AND stock_unit_code = $3
     FOR UPDATE;

Missing row → available 0. Taking the lock here, before any line is applied, means the whole
document's availability is evaluated against a snapshot no other transaction can move.

Lock in a **deterministic order** — sort the `need` map (`:906`) by
`(product_id, stock_unit_code)` before locking — or two vouchers with overlapping item sets
in opposite order will deadlock. This is cheap and non-obvious, so it belongs in the code
with a comment.

Non-van stores keep their current behaviour and rationale, which is already correct and
already documented at `:932`: the local ledger is structurally ~0 for a depot whose stock was
loaded in the ERP, so a depot source is trusted from the approval-time ERP check instead.
`SPEC-erp-authoritative-stock.md` replaces that live check with a persisted snapshot; the
van/warehouse split itself does not change.

### 4.3 The error must reach the rep as a rejection

`InsufficientStockError` maps to `409` with a machine-readable body:

    { code: 'INSUFFICIENT_STOCK',
      itemNumber, stockUnitCode, requested, available }

In the inbox drain (`SPEC-sync-intake-contract.md` §4.3) insufficient stock is classified
**retryable**, because a load TRANSFER may still be queued behind the sale. It becomes
`rejected` only when `MAX_ATTEMPTS` is burnt. That is the one place where "retry" is the
right answer to a stock error; everywhere else it is a refusal the rep must see.

### 4.4 `reserved` must become real before it can be locked

`van_stock.reserved` is **write-only and already known to be wrong.** `effect === 'reserve'`
increments it (`:1275`) and nothing anywhere decrements it — the migration that shipped the
health checks says so in as many words:

> `reserved` is only ever incremented. — `1722500000000-AiChecks.ts:34`

and it ships a `van_stock_inconsistent` check (`:107`) whose whole purpose is to find rows
where `reserved > quantity`. So the defect is not newly discovered; it is monitored.

Meanwhile the read path ignores the column entirely. `VanStockService.forStore`
(`src/modules/products/van-stock.service.ts:97`) derives reserved from open ORDERs:

    LEFT JOIN (SELECT … SUM(vt.item_qty) AS reserved
                 FROM voucher_transactions vt JOIN voucher_headers vh …
                WHERE vh.trans_kind = 'ORDER' AND vh.is_posted AND NOT vh.is_fulfilled …) o

Two notions of the same number: a column that only grows, and an aggregate that is correct
but cannot be locked.

**Resolve to the column**, because §4.2 needs one lockable row to hold the truth for a pool:

1. Emit a `release` effect with the negative delta wherever an ORDER leaves the open set —
   `is_fulfilled` set true, and on cancellation/deletion. Guarded by the same `WHERE`
   in §4.1, so a release can never drive `reserved` below zero.
2. Backfill the column from the derived aggregate in the migration, as the one-time
   reconciliation:

       UPDATE van_stock vs SET reserved = COALESCE(o.reserved, 0)
         FROM (…the forStore subquery, grouped to (rep, product, pool)…) o
        WHERE …;
       -- rows with no open ORDER get 0
       UPDATE van_stock SET reserved = 0 WHERE id NOT IN (SELECT … );

3. Switch `VanStockService.forStore` to read `vs.reserved` and delete the subquery. One
   authority, and the nightly drift job in §5 watches it.

This is not optional polish: §4.2 refuses a sale when `quantity - reserved` is short, so
shipping §4.2 against today's monotonically-growing `reserved` would turn a latent bug into
refused sales on every van. §4.4 and §4.2 go out together or neither goes out.

---

## 5. Drift detection replaces manual recalculation

A daily job (`StockIntegrityService`, `@Cron('20 2 * * *')`) compares, per
`(rep, product, pool)`:

- `van_stock.quantity`
- the `item_balance` ledger for the rep's van store
- the ERP snapshot from `SPEC-erp-authoritative-stock.md`

Any disagreement writes a `stock_integrity_findings` row with `kind = 'drift'` and raises one
notification summarising the count and the worst offenders. It **does not auto-correct** —
silently rewriting a quantity is how the current clamp got its bad reputation. It names the
discrepancy and lets a human decide.

The dashboard gets a Stock integrity panel listing open findings with the three numbers side
by side, so "at source reads 0 while the van is full" is answerable from the dashboard
instead of by running an ERP Inventory Recalculate and hoping.

---

## 6. Acceptance

1. **Lost update is gone.** Two parallel SALE promotions, same rep/item/pool, 3 and 4 from a
   van holding 10. Final `quantity` is exactly 3. Repeat 100× with no divergence.
2. **Overdraft is refused, not clamped.** Van holds 2; sell 5. `409 INSUFFICIENT_STOCK`; no
   voucher row; `quantity` still 2.
3. **The constraint holds.** `UPDATE van_stock SET quantity = -1` is rejected by the database.
4. **No deadlock.** Two vouchers with lines `[A,B]` and `[B,A]` promoted in parallel, 200
   iterations, zero deadlock errors.
5. **Reserve releases.** Create an ORDER (reserves 5), fulfil it. `reserved` returns to its
   prior value; a later sale of the full quantity succeeds.
6. **Drift is reported.** Hand-edit `van_stock` out of step with the ledger. The nightly job
   files a `drift` finding and notifies; the quantity is left alone.

## 7. Rollout

§3 and §4.1–4.2 ship together — the CHECK constraints without the guarded upsert would turn
today's silent clamp into a hard failure with no protection against the race that causes it,
which is strictly worse. §4.4 must be in the same release as §4.2 for the reason given there.
§5 can follow independently.

Before the migration runs on a client, capture `SELECT count(*) FROM van_stock WHERE
quantity < 0` — a non-zero count is the measured size of the problem at that site and is
worth recording in `stock_integrity_findings` for the conversation with the owner.
