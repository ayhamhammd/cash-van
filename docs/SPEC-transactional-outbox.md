# SPEC — Transactional outbox: a posted voucher is always queued for the ERP

Today a voucher commits, and *then* an in-process event asks someone to queue it for the ERP.
A crash, a redeploy or a thrown listener in that gap produces a sale that exists in VanFlow,
does not exist in the ERP, and that **nothing will ever look for again**.

Scope: `erp_outbox`, the `erp.voucher.posted` event, `VouchersService.create`,
`ErpSyncService.onVoucherPosted`. Companion: `SPEC-erp-sync-reconciliation.md` (existing),
`SPEC-sync-intake-contract.md` (the intake that feeds this).

---

## 1. What exists today (verified 2026-09-21)

The outbox itself is good and is **not** being redesigned. `ErpOutboxService` already has
attempts, `next_attempt_at`, exponential backoff, a `dead_letter` state, a `TerminalPayloadError`
class that distinguishes "never possible" from "not yet" (`erp-outbox.service.ts:57`), rate-limit
handling that does not consume an attempt (`:38`), and an `Idempotency-Key` on every push so a
replay cannot duplicate an ERP invoice. That machinery stays exactly as it is.

The defect is in **how a row gets into it.**

### 1.1 The enqueue is outside the voucher's transaction

`VouchersService.create` (`src/modules/vouchers/vouchers.service.ts:271`):

    const result = await this.createUnchecked(dto);   // ← dataSource.transaction, COMMITS here
    await this.recordOfferRedemptions(result, offerResult);
    await this.applyCreditVoucherToDebt(dto);
    await this.recordSaleVisit(dto, saleLoc);
    if (result.isPosted) {
      this.events.emit('erp.voucher.posted', { voucherNumber, transKind });   // :286
    }

`ErpSyncService.onVoucherPosted` (`erp-sync.service.ts:634`) receives it and calls
`outbox.enqueue(kind, voucherNumber)`.

So between the commit at `createUnchecked` and the `INSERT INTO erp_outbox` there are four
awaits, an event dispatch, a settings read (`getErpConfig()`), and a second listener chain
(`event-bridge.service.ts:115`, `cash-accounts.service.ts:207`). Any of the following loses
the enqueue permanently:

- the process is killed or redeployed in that window,
- `applyCreditVoucherToDebt` or `recordSaleVisit` throws (they are **not** wrapped), so `:286`
  is never reached at all,
- `enqueue` itself fails — and it **swallows its own failure** by design
  (`erp-outbox.service.ts:95`: `catch { this.logger.warn(…) }`).

### 1.2 Nothing sweeps for the gap

There is no query anywhere that asks *"which posted vouchers have no `erp_outbox` row?"* The
comment at `erp-sync.service.ts:640` shows the team already reasoned about the adjacent risk —

> a voucher that posted but never reached the ERP is invisible until someone remembers to
> drain that queue

— and fixed it by making the push unconditional. But unconditional only helps if the row
exists. If the enqueue never ran, there is nothing to push and nothing to notice.

### 1.3 The post-commit side effects — corrected after reading them

An earlier draft said these three were unwrapped, so a throw in one would prevent the event at
`:286` from firing at all. **That is wrong: all three already have an internal `try/catch`.**
`recordOfferRedemptions` (`:564`), `applyCreditVoucherToDebt` (`:353`) and `recordSaleVisit`
(`:1279`) each swallow their own failure.

What is actually wrong with `applyCreditVoucherToDebt` is worse, and in a different way:

    const customer = await repo.findOne({ where: { customerNumber } });
    const next = (Number(customer.totalDebt) || 0) + sign * creditAmount;
    customer.totalDebt = Math.max(0, next).toFixed(2);
    await repo.save(customer);

- **A read-modify-write with no lock**, exactly the shape fixed for van stock in
  `SPEC-stock-write-integrity.md`. Two credit sales to one customer at once both read the old
  balance and one overwrites the other. The number that goes missing is what the customer owes.
- **It runs after the commit and swallows its failure into a log line.** So a credit sale can
  post with the debt never applied, and the only symptom is a balance that is quietly short
  until the next ERP balance pull happens to correct it.

So this one moves inside the transaction *and* becomes a relative `UPDATE`, and is allowed to
throw — a credit sale whose debt cannot be recorded should not exist.

`recordOfferRedemptions` and `recordSaleVisit` **stay outside**, deliberately. An offers bug or
a visit-log hiccup must not roll back a sale; that is the existing "offers never block a sale"
decision (`:379`), and it is a decision, not an oversight.

### 1.4 `enqueue` is itself a check-then-insert

`erp-outbox.service.ts:87`:

    const existing = await this.outbox.findOne({ where: { kind, ref } });
    if (existing && existing.status !== 'failed' && …) return;
    const row = existing ?? this.outbox.create({ kind, ref });

There is **no unique constraint on `(kind, ref)`** — only the non-unique `idx_erp_outbox_ref`.
Two concurrent enqueues for the same document create two rows and push twice. The ERP's
`Idempotency-Key` (`row.ref`) means no duplicate invoice is created, so this has been harmless
in practice — but it leaves two local rows disagreeing about `status`, `journal_id` and
`payment_skipped`, which is what the dashboard and the reconciliation report read.

---

## 2. What changes

| | today | after |
|---|---|---|
| Enqueue timing | after commit, via event | **inside the voucher's transaction** |
| Enqueue failure | logged and swallowed | **rolls the voucher back** |
| `erp_outbox (kind, ref)` | no constraint | **UNIQUE** |
| Missed rows | undetectable | **hourly sweep + dashboard counter** |
| Post-commit AR / visit / redemption writes | after commit | **inside the transaction** |
| `erp.voucher.posted` listeners | 3 (outbox, realtime, cash accounts) | 2 — the outbox no longer listens |

The principle: **the decision to tell the ERP is part of the sale, not a consequence of it.**
If the row cannot be written, the sale did not happen.

---

## 3. Schema

`src/database/migrations/1727200000000-TransactionalOutbox.ts`

    -- Collapse any existing duplicates before constraining. Keep the most
    -- informative row: posted beats pending beats failed; newest breaks ties.
    WITH ranked AS (
      SELECT id, kind, ref,
             row_number() OVER (
               PARTITION BY kind, ref
               ORDER BY CASE status WHEN 'posted' THEN 0 WHEN 'pending' THEN 1
                                    WHEN 'failed' THEN 2 ELSE 3 END,
                        updated_at DESC) AS rn
        FROM erp_outbox)
    DELETE FROM erp_outbox WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

    ALTER TABLE erp_outbox
      ADD CONSTRAINT uq_erp_outbox_kind_ref UNIQUE (kind, ref);

    -- The sweep's index: posted van vouchers, cheap to scan by date.
    CREATE INDEX IF NOT EXISTS idx_voucher_headers_posted_kind_created
      ON voucher_headers (trans_kind, created_at)
      WHERE is_posted = TRUE;

The `UNIQUE` is what lets §4.1 use `ON CONFLICT DO NOTHING` instead of a read.

---

## 4. Backend

### 4.1 `enqueue` gains a transactional form

    /** Transactional enqueue: takes the caller's EntityManager, so the row commits
     *  with the document or not at all. Throws — the caller must not swallow it. */
    async enqueueWithin(em: EntityManager, kind: ErpOutboxKind, ref: string): Promise<void> {
      await em.query(
        `INSERT INTO erp_outbox (kind, ref, status, attempts, next_attempt_at)
         VALUES ($1, $2, 'pending', 0, now())
         ON CONFLICT (kind, ref) DO UPDATE
            SET status = CASE WHEN erp_outbox.status IN ('failed','dead_letter')
                              THEN 'pending' ELSE erp_outbox.status END,
                next_attempt_at = CASE WHEN erp_outbox.status IN ('failed','dead_letter')
                              THEN now() ELSE erp_outbox.next_attempt_at END`,
        [kind, ref]);
    }

The `DO UPDATE` preserves today's semantics from `:88` — a re-enqueue revives a `failed` or
`dead_letter` row and leaves a `pending`/`posted` one alone — but as one statement.

The existing `enqueue(kind, ref)` stays for the callers that are genuinely best-effort and
outside any document transaction (`pushWarehouse`, customer edits, approved stock requests).
It delegates to `enqueueWithin` on a fresh manager. Its `catch`-and-warn is correct **there**
and wrong for a voucher; the two forms exist so the difference is explicit at each call site.

### 4.2 `createUnchecked` enqueues before it commits

Inside the `dataSource.transaction(async (em) => …)` at `:641`, after the header, lines,
payments and stock movements are written and `isPosted` is known:

    if (header.isPosted && !header.voucherNumber.startsWith('ERP-')) {
      const kind = OUTBOX_KIND_BY_TRANS[header.transKind];
      if (kind && (await this.settings.getErpConfig()).enabled) {
        await this.erpOutbox.enqueueWithin(em, kind, header.voucherNumber);
      }
    }

Three details that are easy to get wrong:

- **The `ERP-` guard moves with the logic.** It lives at `erp-sync.service.ts:645` today and is
  the loop guard against re-pushing a voucher mirrored *in* from the ERP. It must be applied
  here, or the mirror will push its own imports back.
- **`OUTBOX_KIND_BY_TRANS` must be importable from the vouchers module.** It is currently
  defined in `erp-sync.service.ts`; `erp-sync` imports `vouchers`, so the reverse import is
  circular (the same constraint already documented at `vouchers.service.ts:940`). Move the map
  to a shared const file — `src/modules/erp-sync/outbox-kinds.ts` — with no Nest dependencies,
  and import it from both.
- **`getErpConfig()` decrypts the stored API key and throws when it cannot**
  (`erp-outbox.service.ts:135` documents this). Inside a voucher transaction that would refuse
  sales because a key is undecryptable. So gate on a cheap boolean — read `enabled` from the
  settings row directly, not through the decrypting accessor — and let the drain keep being the
  place that reports a bad key.

### 4.3 The AR debt moves in, and becomes atomic

`applyCreditVoucherToDebt` takes the caller's `EntityManager`, runs inside the voucher's
transaction, and stops reading before it writes:

    UPDATE customers
       SET total_debt = GREATEST(0, COALESCE(total_debt, 0) + $2::numeric)
     WHERE customer_number = $1

`GREATEST(0, …)` is kept: debt below zero is a credit-note question and this is not the place to
invent an answer. The internal `try/catch` is removed — a credit sale whose debt cannot be
recorded should not exist.

The other two keep their current placement and their guards, for the reason in §1.3. State that
in the code, so the asymmetry reads as a decision rather than an accident.

### 4.4 The event keeps its other two subscribers

`erp.voucher.posted` still fires at `:286` for `event-bridge.service.ts:115` (realtime push to
the dashboard) and `cash-accounts.service.ts:207`. Only `ErpSyncService.onVoucherPosted` is
deleted, and with it the last path by which a posted voucher could fail to be queued.

Check `cash-accounts.service.ts:207` while doing this: if it moves money, it belongs in the
transaction too, on the same reasoning as §4.3. Decide it explicitly rather than by omission.

### 4.5 The sweep, as a backstop

`ErpOutboxSweepService`, `@Cron('7 * * * *')` — hourly, cheap, and the thing that makes this
spec verifiable rather than merely believed:

    SELECT h.voucher_number, h.trans_kind, h.created_at
      FROM voucher_headers h
      LEFT JOIN erp_outbox o
             ON o.ref = h.voucher_number
            AND o.kind = CASE h.trans_kind WHEN 'SALE' THEN 'SALE_INVOICE'
                                           WHEN 'RETURN' THEN 'SALES_RETURN'
                                           WHEN 'ORDER' THEN 'SALES_ORDER' END
     WHERE h.is_posted
       AND h.trans_kind IN ('SALE','RETURN','ORDER')
       AND h.voucher_number NOT LIKE 'ERP-%'
       AND h.created_at < now() - INTERVAL '10 minutes'
       AND o.id IS NULL
     LIMIT 500;

Each hit is enqueued and counted. **The count is the metric**: after this spec ships it must
be zero, and any non-zero value is either a bug in §4.2 or a route that creates posted
vouchers without going through it. Surface it on the ERP status page next to the outbox
counters, not only in the log.

Run the sweep once manually on each client before ship — whatever it finds is the accumulated
backlog of §1.1 at that site, and those are real invoices missing from the ERP today.

---

## 5. Acceptance

1. **Crash safety.** Post a SALE with a `SIGKILL` injected immediately after commit (test hook,
   or a listener that throws). The `erp_outbox` row exists, because it committed with the
   voucher.
2. **Atomicity in the other direction.** Force `enqueueWithin` to throw. No voucher row, no
   stock movement, no outbox row. The intake returns a retryable failure.
3. **No duplicates.** Enqueue the same `(kind, ref)` 20× in parallel. One row.
4. **Revival still works.** A `dead_letter` row re-enqueued by a dashboard retry returns to
   `pending` with `next_attempt_at = now()`.
5. **Mirror loop guard.** Promote a voucher numbered `ERP-…`. No outbox row.
6. **Sweep reads zero.** After the release, the hourly sweep finds nothing across a day of
   real traffic. Before the release, on each client, it finds and reports the backlog.
7. **AR is atomic.** Force the debt `UPDATE` to throw on a credit SALE: no voucher is created.
   Then post two credit sales of 100 to one customer in parallel from a balance of 0 — the
   balance is exactly 200, not 100. The second half is the lost update, and it fails before
   this change.

## 6. Rollout

Order matters, because the middle state must be safe:

1. Migration (dedupe + `UNIQUE` + index). Harmless on its own.
2. `enqueueWithin`, `outbox-kinds.ts` extraction, and the **sweep** — with the event listener
   still in place. Now there are two paths to the same row and the unique constraint makes
   that safe, so nothing can be lost while the change is half-deployed.
3. `createUnchecked` enqueues transactionally; delete `ErpSyncService.onVoucherPosted`.
4. Move the AR write inside the transaction and make it relative (§4.3). The redemption and
   visit writes stay where they are.

Keep the sweep permanently. It costs one indexed query an hour and it is the only thing that
can tell you this spec is still true a year from now.
