# SPEC — Stock write integrity: no lost updates, no silent clamping

Two concurrent documents touching the same van pool currently lose one of the two
deductions, and the code then hides the discrepancy instead of refusing it. This closes both.

Scope: `van_stock`, `damaged_stock`, the availability check in `VouchersService.createUnchecked`,
and the `item_balance` view. Companion: `SPEC-erp-authoritative-stock.md` (which store is the
book of record), `SPEC-sync-intake-contract.md` (why concurrent van writes are now routine).

---

## 1. What exists today (verified 2026-09-21)

### 1.0 `van_stock` is only a PARTIAL mirror — found during implementation

`applyLineToVan` is called from **`post()` only** (`vouchers.service.ts:1120`), the path that
posts an existing draft. `create()` never calls `post()`. So a mobile voucher created with
`isPosted: true` — which is every promoted handset document
(`sync.service.ts:180`, `dto.isPosted = true`) — moves stock **only** through
`voucher_transactions`, and therefore only through the `item_balance` view. It never touches
`van_stock`.

That reframes everything below:

- the lost update in §1.1 is real, but confined to the draft-post path (TRANSFER, ORDER
  reserve, damaged returns) — not to van sales;
- **`van_stock` cannot be the lockable authority for the availability check**, because the
  writer the check needs to serialise against does not write it. The original §4.2 of this
  spec said otherwise and was wrong;
- the actual overselling race is in the `item_balance` check, against a **view**, which is
  the one thing that genuinely cannot be locked. §4.2 is rewritten accordingly.

Two stores of the same quantity, one maintained on one code path and one on another, is the
deeper defect. Unifying them belongs with `SPEC-erp-authoritative-stock.md`; what follows
makes today's arrangement safe without pretending it is coherent.

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

**Correction, found while implementing.** An earlier draft of this spec said the database would
not catch it either. It would: `ck_van_stock_qty_nonneg CHECK (quantity >= 0)` has existed since
`van_stock` was created (`1716100000000-ExtendItemsAndAddPricingVanStock.ts:99`). The clamp was
therefore *load-bearing* — it is what kept that constraint from firing. The defect is not a
negative row in the database; it is that an overdraft of three was written as **0 instead of
being refused**, leaving a legal number that is wrong and a pool that reads "empty" when it has
been oversold.

`reserved` is the column with no constraint, and unlike `quantity` it is reachable — which is
precisely what the `van_stock_inconsistent` health check (`1722500000000-AiChecks.ts:107`) was
built to detect after the fact. `damaged_stock` (`1725900000000`) has no constraint either.
Those two are what §3 adds; re-adding `quantity >= 0` would be a second identical rule and a
scan on every write.

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
| DB guarantee | `quantity` only | **+ `CHECK (reserved >= 0)`, + `damaged_stock`** |
| Availability check source | `item_balance` view | unchanged — but read under a lock |
| Serialisation | none | **`pg_advisory_xact_lock` per (store, item, pool)** |
| Reconciliation | manual ERP recalculate | **scheduled drift check with an alarm** (§5) |

The design choice worth stating plainly: **the pool key becomes the lock, not any row.** Since
`van_stock` is not written by the path that creates posted van sales (§1.0) and `item_balance`
is a view, there is no row to lock — so the serialisation is an advisory lock on
`(store, item, pool)`, held for the transaction. Same granularity a row lock would have given
(two reps, or two items, never contend) with none of the schema change.

Making one table the real authority for van stock is the right end state. It is a larger
change that belongs with `SPEC-erp-authoritative-stock.md`, and it is not needed to stop the
overselling.

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

### 4.2 The availability check serialises on an advisory lock

`van_stock` is not written by the path that creates posted van sales (§1.0), so locking it
would serialise nothing. The check reads `item_balance`, and a view has no rows to lock.

Take a transaction-scoped advisory lock per pool instead, immediately before the check:

    const lockKeys = [...need.values()]
      .filter((n) => vanStores.has(n.store))
      .map((n) => `${n.store}\u0000${n.itemNumber}\u0000${n.stockUnitCode}`)
      .sort();
    for (const key of lockKeys) {
      await em.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    }

Why this is the right instrument here:

- **It gives the check something to hold.** The lock is released on commit or rollback, so the
  window from "read the balance" to "insert the lines" is exclusive for that pool. The second
  voucher's `item_balance` read then already includes the first one's rows.
- **No schema, no new authority.** It does not require inventing a lockable stock row, which is
  a larger change that belongs with the ERP-snapshot work.
- **It contends narrowly.** Two reps, or the same rep on different items, never wait on each
  other.
- **Deterministic order (`.sort()`) is load-bearing.** Two vouchers naming the same two items in
  opposite order would otherwise deadlock. This is cheap, invisible in behaviour, and the kind
  of thing that gets dropped in a refactor — hence the comment in the code.
- `hashtextextended(text, int8)` returns `bigint`, matching `pg_advisory_xact_lock(bigint)`.
  Both are core Postgres; the deployed server is 16.4.

Non-van stores keep their current behaviour and rationale, already documented at `:932`: the
local ledger is structurally ~0 for a depot whose stock was loaded in the ERP, so a depot source
is trusted from the approval-time ERP check instead. `SPEC-erp-authoritative-stock.md` replaces
that live check with a persisted snapshot; the van/warehouse split itself does not change.

### 4.3 The error must reach the rep as a rejection

`InsufficientStockError` maps to `409` with a machine-readable body:

    { code: 'INSUFFICIENT_STOCK',
      itemNumber, stockUnitCode, requested, available }

In the inbox drain (`SPEC-sync-intake-contract.md` §4.3) insufficient stock is classified
**retryable**, because a load TRANSFER may still be queued behind the sale. It becomes
`rejected` only when `MAX_ATTEMPTS` is burnt. That is the one place where "retry" is the
right answer to a stock error; everywhere else it is a refusal the rep must see.

### 4.4 `reserved`: released on fulfil, but not on cancel

An earlier draft of this spec said `reserved` is never decremented, following the note left in
`1722500000000-AiChecks.ts:34`:

> `reserved` is only ever incremented.

**That note is stale.** `fulfil()` (`vouchers.service.ts:1192`) does release it:

    vs.reserved = Math.max(0, vs.reserved - qty);
    vs.quantity = Math.max(0, vs.quantity - qty);

So the column is maintained on the happy path. Two things remain:

1. **That release was itself a read-modify-write** with the same lost-update shape as §4.1, and
   is now the same atomic `UPDATE`. `GREATEST(0, …)` is deliberately **kept** there, unlike in
   §4.1: a reservation that no longer covers the line is a bookkeeping artefact of an order
   placed before the stock moved, not an overdraft, and refusing to fulfil goods the rep has
   already handed over would strand the order with no way forward.
2. **Cancellation still leaks.** An ORDER that is deleted or abandoned without being fulfilled
   never returns its reservation, so `quantity - reserved` drifts down over time. That is what
   the `van_stock_inconsistent` health check (`AiChecks.ts:107`) actually detects. Emit a
   release on the cancel/delete path too.

The read path is a separate question: `VanStockService.forStore`
(`van-stock.service.ts:97`) ignores the column entirely and derives reserved from open
unfulfilled ORDERs. Two notions of one number, one of them lockable and one of them correct.
Resolving them to the column — with a backfill from the aggregate — is worth doing, but it is
**not** a prerequisite for §4.2 any more, because §4.2 no longer reads `reserved`.

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
3. **The constraints hold.** `UPDATE van_stock SET quantity = -1` is rejected (it always was);
   `UPDATE van_stock SET reserved = -1` and `UPDATE damaged_stock SET quantity = -1` are now
   rejected too.
4. **No deadlock.** Two vouchers with lines `[A,B]` and `[B,A]` promoted in parallel, 200
   iterations, zero deadlock errors.
5. **Reserve releases.** Create an ORDER (reserves 5), fulfil it. `reserved` returns to its
   prior value. Then create an ORDER and CANCEL it: `reserved` must also return — this is the
   leak §4.4 identifies, and the test should fail before that fix lands.
6. **Drift is reported.** Hand-edit `van_stock` out of step with the ledger. The nightly job
   files a `drift` finding and notifies; the quantity is left alone.

## 7. Rollout

§3 and §4.1 ship together — the CHECK constraints without the guarded upsert would turn today's
silent clamp into a hard failure with no protection against the race that causes it, which is
strictly worse. §4.2 (the advisory lock) is independent of both and can ship alongside or
before. §4.4's cancel-path release and §5 follow independently.

Before the migration runs on a client, capture `SELECT count(*) FROM van_stock WHERE
reserved > quantity` — that, not a negative quantity, is the measured size of the problem at
that site, and it is worth recording in `stock_integrity_findings` for the conversation with
the owner. (The migration records it automatically; take the number first so you know it
before the repair.)
