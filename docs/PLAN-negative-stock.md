# Selling below zero — how the ERP does it, and how to bring it to cash van

**Status:** proposal. Nothing in this document is implemented in cash van yet.
**Source of the design:** the ERP, where this already works (`src/lib/inventory/negative-stock.ts`).

---

## The problem, in the words of a driver

A van's stock is genuinely uncertain between the morning load and the day
closing. The goods on it are real whatever the balance says. Today cash van
refuses the sale:

> `Not enough stock of 442 in store 105: have 0, need 1`

The rep is standing in a shop with the item in his hand. He sells it anyway —
off the books, on a paper pad, or by picking a different item code until one
goes through. The refusal did not prevent the sale. It only prevented the
system from knowing about it, which is worse than a negative balance somebody
can see and fix.

That is the whole case for allowing it. It is not a relaxation of control; it
is choosing a visible wrong number over an invisible one.

## Why it is not allowed everywhere

It costs something real, and the cost is invisible unless it is written down.
The ERP's module states three, and all three apply to cash van:

1. **COGS is taken at a stale cost.** Sell from a pool holding nothing and the
   cost posted is whatever the last average was. When the stock actually
   arrives at a different price, that profit is never corrected.
2. **Inventory shows a negative asset.** The stock account is credited for
   goods never received — an impossible balance, and one nobody can explain to
   an auditor a year later.
3. **It hides drift instead of fixing it.** A van that is quietly wrong stays
   quietly wrong, and every count from then on shows a variance nobody can
   account for.

So it is **opt-in per warehouse** — a van, never the main store — and the
balances it produces are **reported**, not left to be discovered.

---

## How the ERP is built

### Two settings, not one

| Scope | Column | Default |
|---|---|---|
| Organisation | `organizations.allow_negative_warehouse_stock` | `false` |
| Warehouse | `warehouses.allow_negative_stock` | `false` |

The per-warehouse flag is the one that matters. Its comment says why: *"Per
warehouse, not per organisation: a van's stock is genuinely uncertain between
the morning load and the day closing."* The main store has no such excuse — if
it is short, something is wrong and the sale should stop.

### One pure function decides

`src/lib/inventory/negative-stock.ts`:

```ts
export function mayGoNegative(ctx: {
  warehouseAllowsNegative: boolean;
  lotTracked: boolean;
  serialTracked: boolean;
}): boolean {
  if (ctx.lotTracked || ctx.serialTracked) return false;
  return ctx.warehouseAllowsNegative;
}
```

**Tracking wins over the setting, never the other way round.** A lot- or
serial-tracked item cannot be sold from nothing whatever the flag says: the
sale has to name a lot or a serial and there is none to name. Allowing it would
mean inventing a lot number — a worse lie than a blocked sale, because the
expiry date and the traceability behind it are the entire reason the item is
tracked.

### The inverse is named for the call site

```ts
export function guardNonNegativeFor(ctx): boolean { return !mayGoNegative(ctx); }
```

So nobody has to invert a boolean in their head at the moment they are reading
a stock deduction. Small thing; it is the kind of small thing that causes the
bug this file exists to prevent.

### The pure half and the database half are separate files

`negative-stock.ts` is pure and imported by client components — the transfer
form decides **on screen** whether a short line is a warning or a refusal.
Reaching the database from it would pull `@/db` into the browser bundle and
throw `DATABASE_URL is missing` on page load. The lookup lives in
`negative-stock-db.ts` instead.

### Every path asks the same function

This is the part worth copying most. From the ERP's own notes:

> The setting lives on the warehouse, but for a long time only the deduction
> itself asked it — and several paths refuse BEFORE the deduction, with checks
> of their own that never looked: a sales order read only the organisation-wide
> flag, a direct invoice computed the warehouse's answer and then ran a
> pre-check that ignored it, and production and POS asked nothing at all. A
> warehouse switched on was refused anyway, in every one of them.

A flag that one code path honours and four ignore is worse than no flag: the
setting appears to be on, and the refusal still happens, so the next person
concludes the feature is broken rather than that their path forgot to ask.

### The negative is reported as money

```ts
export function negativeValue(quantity: number, unitCost: number): number
```

A van short twelve units of something costing 4.000 is carrying a **48.000
hole** in the inventory account. That is the number finance needs, not the
quantity. An item with no cost recorded returns `0`, not `-0`, because `-0`
prints in a report and reads as a defect.

---

## What cash van does today

Two separate refusals, neither aware of any setting:

**1. Pre-check before posting** — `vouchers.service.ts`, inside the advisory
lock:

```ts
if (available < n.qty) {
  throw new BadRequestException(
    `Not enough stock of ${n.itemNumber}${unit} in store ${n.store}: have ${available}, need ${n.qty}`,
  );
}
```

**2. The deduction itself** — the `van_stock` upsert carries the guard in SQL:

```sql
WHERE van_stock.quantity + $4 >= 0
  AND van_stock.reserved + $5 >= 0
```

Zero rows returned means the guard refused it, and the service raises
`INSUFFICIENT_STOCK`.

Note the shape already matches the ERP: **a pre-check and a deduction guard**.
Cash van simply has no way to turn either off, and `warehouses` has no flag at
all.

---

## Bringing it across

### 1. The flag

Add to `warehouses`, mirroring the ERP's name and default:

```ts
@Column({ name: 'allow_negative_stock', type: 'boolean', default: false })
allowNegativeStock!: boolean;
```

Default `false`, so nothing changes for anyone until it is switched on. Expose
it on the warehouse screen for **van** warehouses only — the main store should
not offer it.

### 2. The decision, in one pure file

`src/modules/warehouses/negative-stock.ts`, with no NestJS and no repository —
the same reason the ERP keeps it pure, and it makes the rules testable without
a database:

```ts
export function mayGoNegative(ctx: {
  warehouseAllowsNegative: boolean;
  isVan: boolean;
}): boolean {
  if (!ctx.isVan) return false;        // the main store never goes below zero
  return ctx.warehouseAllowsNegative;
}
```

Cash van has no lot or serial tracking today, so `isVan` replaces that guard as
the rule that overrides the setting. **Keep the override, whatever the field**:
it is what stops the flag being switched on somewhere it must never apply.

### 3. Both refusal sites ask it

The pre-check:

```ts
if (available < n.qty && !mayGoNegative({ warehouseAllowsNegative, isVan })) {
  throw new BadRequestException(...);
}
```

And the SQL guard, which must drop its `WHERE` clause when negatives are
permitted — otherwise the upsert silently returns zero rows and the service
reports `INSUFFICIENT_STOCK` for a sale the policy just allowed. **This is the
trap the ERP describes**: one path honouring the setting and another ignoring
it, so the feature looks broken.

Both call the same function. If a third path appears later, it asks the same
question in the same words.

### 4. Report what it produces

A van allowed to go negative **will** go negative, and nobody looks at a number
they are not shown. Add to the stock screen, or the day closing:

- every pool below zero, by van
- the quantity and the value (`qty x unit cost`), so finance sees the hole

The 77 client reached `-46` on one item during testing and nobody noticed until
the balances were read directly in the database. That is the failure this step
prevents.

### 5. Keep `GREATEST(..., 0)` on insert

The upsert clamps a **fresh** row to zero:

```sql
VALUES ($1, $2, $3, GREATEST($4, 0), GREATEST($5, 0), ...)
```

That is correct and should stay. A pool with no row at all is a different
condition — the item was never loaded onto that van — and the availability
check upstream already rejects it. Going negative from nothing is not "the
balance is stale"; it is "this item is not on this van".

---

## What not to do

**Do not make it organisation-wide.** The ERP has such a flag and its own
modules route around it in favour of the per-warehouse one. One switch for the
whole company means the main store inherits the van's excuse.

**Do not let it suppress the error message.** When a sale goes below zero, the
rep should still be told — a warning, not a refusal. Silence is how drift
becomes invisible again.

**Do not reset negatives by hand.** They are evidence. Fix them with a stock
count or a load, so the correction is a movement somebody can read later.

---

## Checklist

- [ ] `warehouses.allow_negative_stock`, default `false`, migration + entity
- [ ] Pure `mayGoNegative`, with the van-only override
- [ ] Pre-check in `vouchers.service.ts` asks it
- [ ] `van_stock` upsert drops its `>= 0` guard when permitted
- [ ] Insert still clamps a fresh row with `GREATEST(..., 0)`
- [ ] Negative balances reported by van, with value
- [ ] Toggle shown on van warehouses only
- [ ] Tests: van allowed goes negative; main store refuses; fresh pool refuses
