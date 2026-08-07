# Returns without picking a sale voucher

How the ERP does it, what cash van does today, and what it would take to behave
identically on the van, the dashboard, and over the wire.

---

## 1. What the ERP actually does

The ERP has **two** return paths, and they are not the same shape.

### 1a. The v1 API — invoice required

`POST /api/v1/sales-returns` (`src/app/api/v1/sales-returns/route.ts`) requires
the source invoice:

```ts
originalInvoiceNumber: z.string().min(1)   // not optional
```

and rejects any line whose SKU was not on that invoice:

```
SKU_NOT_ON_INVOICE — SKU 'X' was not on invoice 'INV-123'.
```

**This is the endpoint cash van calls.** There is no "figure it out for me" mode
on the integration API.

### 1b. The dashboard — "Return by item"

`src/app/dashboard/sales/returns/` lets a user return **items**, not a document.
They pick SKUs and quantities; the system works out which invoices those units
came from. That is the behaviour the request is describing.

It is not a lookup of "the last sale voucher". **Each item on the return is
sourced from that item's sale vouchers, taken in order** until its quantity is
met:

```
for each requested ITEM:
    pool = that item's still-returnable sale lines
    pool.sort(strategy)                  ← the strategy ONLY decides the order
    walk the pool in order, taking min(remaining, outstanding) from each
```

Three consequences, and they are the whole design:

- **one item can span several sale vouchers** — 6 from the newest, then 4 from
  the next
- **different items on one return can come from different vouchers** — each item
  runs its own independent walk
- **the number of resulting documents is not knowable from the return alone** —
  which is why the split happens at creation, not at push time (§4)

Their own test states it:

```
request 10 of sku-1;  INV-A (05-02, 6 units), INV-B (05-01, 4 units), NEWEST_FIRST
  → [["INV-A", 6], ["INV-B", 4]]     "one credit note per source invoice"
```

When the order runs out before the quantity does, the remainder is reported as
`unallocated` — *"reports what it could not source rather than silently
short-refunding"*.

The pieces, in `src/lib/sales/returns/`:

```
findReturnCandidates()  →  every invoice line that could still supply these SKUs
allocateReturn()        →  the per-item ordered walk above
createReturnFromPlan()  →  one credit note PER SOURCE INVOICE
```

**The user chooses the matching rule** (`RETURN_STRATEGIES`):

| Strategy | What it means |
|---|---|
| `NEWEST_FIRST` | Most recent sale first. The usual choice, and the closest thing to "last sale voucher" |
| `OLDEST_FIRST` | Oldest open sale first — clears aged lines, refunds the older price |
| `CLOSEST_PRICE` | The sale whose unit price is nearest what the customer says they paid |
| `LARGEST_REMAINING` | The sale with the most units still returnable — fewest credit notes |

So "depends on the last sale voucher" is `NEWEST_FIRST`, which is one of four,
and the default a user would normally pick.

### The four invariants worth copying

These are the parts that are easy to get wrong, and the ERP has already paid for
learning them:

**1. Determinism, via a stable tie-break.** "Newest first" is ambiguous the
moment two invoices share a date — normal for van sales, where a driver raises a
dozen invoices in one morning. Every comparator ends with the same tie-break
(invoice number, then invoice-line id), appended centrally by
`compareCandidates` rather than trusted to each strategy. Without it the preview
and the commit can allocate differently, so the user confirms one thing and the
system creates another.

**2. One credit note per source invoice.** The JoFotara `BillingReference`
carries a single invoice id, UUID and total, so a credit note cannot span
several invoices. Ten units sourced from two invoices is **two compliant
documents**, not one non-compliant one.

**3. Remaining-returnable is enforced, and floored at zero.** Candidates exclude
`quantity_returned >= quantity_billed`, and the allocator tracks a `consumed`
map so the same SKU requested twice cannot draw the same units twice.

**4. The allocation is re-checked inside the transaction.** The preview reads
candidates outside any lock. Between preview and confirm, someone else may have
returned the same goods or posted the invoice. `lockAndCheckReturnable` re-runs
it under row locks.

Also note: candidates deliberately **do not filter by customer** unless one is
identified. `invoices.customer_id` is NOT NULL and `payment_type = 'CASH'` means
paid immediately, not anonymous — so cash and walk-in sales need no special case.

---

## 2. What cash van does today

A RETURN voucher carries an **optional** `referenceVoucherNumber`
(`create-voucher.dto.ts`). So the van can already raise a return without naming
a sale — the UI permits it and the voucher saves fine.

**But it can never reach the ERP.** `ErpOutboxService.buildReturn` is:

```ts
const ref = header.referenceVoucherNumber;
if (!ref) return null;                      // ← no reference, no payload
```

and a null payload is handled as:

```ts
return this.fail(row, 'payload could not be built (source missing)');
```

So an unreferenced return burns its retry attempts and lands in **dead-letter**,
with a message that misdescribes the problem — the source voucher is not
missing, there simply never was a reference. Retrying cannot fix it, because no
amount of retrying invents a source invoice.

**This is the same class of bug as the customer-export one:** a legitimate
document silently fails to reach the ERP, and nothing in the UI says so.

---

## 3. What to build

### 3a. Backend — a returns allocator (mirror of the ERP's)

New module `src/modules/vouchers/returns/`, deliberately shaped like
`ERP/src/lib/sales/returns/` so the two stay comparable:

| File | Job |
|---|---|
| `candidates.ts` | Posted SALE lines for these items with `remaining > 0`, optionally narrowed to one customer |
| `strategies.ts` | The same four comparators, same central tie-break |
| `allocate.ts` | Pure function: `(request, candidates, strategy) → plan` |
| `create.ts` | Plan → **one RETURN voucher per source sale**, in one transaction |

**Remaining-returnable needs a column cash van does not have.**
`voucher_transactions` has no `quantity_returned`. Add it, and maintain it when
a return posts — otherwise the same units can be returned repeatedly, which is
the failure mode the whole guard exists to prevent.

```sql
ALTER TABLE voucher_transactions
  ADD COLUMN qty_returned numeric NOT NULL DEFAULT 0;
```

**Match on the item + unit pair, not the item.** Cash van sells the same item in
several units (the per-unit stock work), and a return of 1 carton is not a
return of 1 piece. Candidates must key on `(item_number, item_unit_id)` and the
allocator must compare like with like, or a carton return will silently consume
a piece line's remaining quantity.

**Endpoints:**

```
POST /vouchers/returns/preview   → { plan, alternatives, unallocated }
POST /vouchers/returns/confirm   → { vouchers: [...] }   (N vouchers)
```

Preview must be a separate call — the user has to see and confirm the match
before N documents exist. Return the other strategies' outcomes alongside, the
way the ERP's `compareStrategies` does, so "why did it pick that invoice" is
answerable on screen instead of by argument.

### 3b. Dashboard

A **Return by item** screen next to the existing return flow:

1. pick customer (optional) → pick items + quantities
2. choose strategy (default `NEWEST_FIRST`)
3. **preview** — the allocation table: which sale each unit came from, at what
   price, and anything unallocatable stated plainly rather than dropped
4. confirm → N return vouchers

The unallocated list is not a detail. A customer returning 10 units when only 7
are still returnable must be told which 3 could not be matched, before anything
is created.

### 3c. Mobile

Same flow, one strategy: `NEWEST_FIRST`, not user-selectable. A salesman
standing in a shop should not be choosing an allocation policy, and the office
can re-do it if the match is wrong. The screen still shows which sale each unit
matched, because the customer is standing there asking.

---

## 4. Sending it to the ERP identically

**The transport already supports this.** `ErpOutboxService` loops over calls:

```ts
// A document may map to >1 call; each carries its own externalId, so a
// retry replays them idempotently.
for (const c of calls) { await this.erp.post(c.path, c.body, c.idem ?? row.ref); }
```

Today every kind returns exactly one call. Returns become the first kind that
returns several, which is what the loop was written for.

### The rule

**One cash van return voucher per source sale — decided at creation, not at push
time.** Because:

- the v1 API takes a single `originalInvoiceNumber`
- one credit note per invoice is a **JoFotara** constraint, not a preference
- `externalId` is the idempotency key, so each document needs its own; a single
  van voucher fanned out at push time would need synthesised ids, and a retry
  after a timeout could double-post

So the allocator's "one voucher per source invoice" split on the van mirrors the
ERP's "one credit note per invoice" exactly. Each van voucher then pushes
through the **existing** `buildReturn` unchanged, because each one *does* have a
`referenceVoucherNumber`.

### Mapping

| Cash van | ERP v1 |
|---|---|
| `voucherNumber` | `externalId` (idempotency key) |
| `referenceVoucherNumber` → id-map → `erpCode` | `originalInvoiceNumber` |
| `userCode` | `deviceId` |
| van store of the lines | `warehouseCode` (goods return to the van) |
| line `itemNumber` + unit → SKU | `skuCode` |

All of that is already implemented in `buildReturn`. **Nothing in the ERP push
needs to change** — the fix is upstream, in never creating an unreferenced
return in the first place.

### The one thing that must still be fixed

The DTO has always allowed unreferenced returns, so they *can* exist — though as
of writing there are **none** in the database, which is why nobody has hit this
yet. It is a live trap, not a live incident.

Once the allocator lands, `buildReturn`'s `if (!ref) return null` should fail
honestly rather than with the misleading "payload could not be built (source
missing)". There is no dead-letter helper today — dead-lettering only happens
inside `fail()` once `attempts >= MAX_ATTEMPTS` — so this needs a small addition:

```ts
// in fail(), or a sibling: some failures are terminal on the first look
private async failTerminal(row: ErpOutbox, error: string): Promise<void> {
  row.attempts += 1;
  row.error = error;
  row.status = 'dead_letter';
  await this.outbox.save(row);
}
```

Terminal on the first attempt, not after five: no number of retries will invent
a source invoice, and burning the retry budget only delays the operator finding
out.

---

## 5. Order of work

1. `qty_returned` column + maintenance when a return posts *(nothing else is correct without it)*
2. Allocator: candidates → strategies → allocate → create *(pure, unit-testable)*
3. Preview + confirm endpoints
4. Dashboard Return-by-item screen
5. Mobile screen, `NEWEST_FIRST` only
6. `buildReturn` honest dead-letter for legacy unreferenced returns

Steps 1–2 carry the risk; they are also the parts that can be tested without any
UI, which is the argument for doing them first and separately.
