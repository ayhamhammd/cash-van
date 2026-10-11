# Returnable containers — implementation plan

Branch `feat/returnable-containers` in all four repos (ERP, cash-van-dashboard,
cash-van-dashboard-frontend, FlowVan), cut from `origin/dev`.

**The business problem.** A dairy rep sells ten 6 kg buckets of halloumi. Days
later the customer hands back three *empty* buckets. The empty bucket has no
sale value; the company needs to know how many it is owed, by whom, and how long
they have been out. Crates and baskets to other companies work the same way.

---

## 1. The model

**The empty container is a product in its own right, and it is never sold.**

Three columns on the ERP `products` table say how a product relates to its
packaging — following the `is_tobacco_product` + `tobacco_tax_profile_id`
precedent (`ERP/src/db/schema.ts:340`):

| Column | Meaning |
|---|---|
| `is_returnable_container` | This product IS an empty container ("سطل حلوم فارغ"). Zero `selling_price`, `item_type = 'STOCK'`. |
| `container_product_id` | This product SHIPS IN that container. Null for everything that does not. |
| `containers_per_base_unit` | Containers per **base piece**. 1 for a 6 kg tub; a carton of 4 carries 4. |

### The three movements

```
            ┌──────────────────────── derived, never a document ──────────┐
  SALE of 10 tubs  ───────────────────────────────────────────────►  10 containers out
            └─────────────────────────────────────────────────────────────┘

  CONTAINER_IN   (rep raises it; zero value)   ─────────────────────►   3 containers back
  CONTAINER_OUT  (rep raises it; zero value)   ─────────────────────►   crates lent with no sale
```

**Containers out are derived from the sale, not documented.** Nothing is added to
the invoice, nothing is printed, no zero-price line appears. This is the whole
point of the design: you do not sell an empty bucket, so no document says you
did. The outstanding count is computed from invoice lines whose product carries
a `container_product_id`.

**Containers in is one new zero-value document.** It carries customer + container
product + quantity. It moves van stock `in` through the existing `VAN_EFFECT`
map (`vouchers.service.ts:79`), and deliberately touches none of the money path:
no credit note, no tax, no `applyCreditVoucherToDebt`, no JoFotara.

**Containers out as a document** exists only for the case where packaging goes
out without a sale — a stack of crates lent to a company. Same shape, opposite
sign.

### The balance

```
customer holds  =  Σ (base pieces sold × containers_per_base_unit)
                +  Σ CONTAINER_OUT qty
                −  Σ CONTAINER_IN  qty
```

No `qty_returned`-style counter to maintain, and therefore no allocation against
a particular invoice. Three buckets back out of ten sold across four visits is
simply `10 − 3 = 7`. Partial returns, returns months later, and returns that
span any number of invoices all work without special handling.

> **Why not the existing return machinery.** The return-by-item allocator
> (`src/modules/vouchers/returns/`) matches a returned item against past SALE
> lines *of that same item*. An empty bucket was never a sale line, so there is
> nothing to allocate against. And the ERP's `POST /api/v1/sales-returns`
> requires `originalInvoiceNumber` and rejects any SKU that was not on it — see
> `docs/RETURNS-without-a-sale-voucher.md` §1a. A container return is not a
> sales return; treating it as one would need a fake invoice reference.

---

## 2. Decisions taken

Recorded because they were not explicitly settled and the work depends on them.
Each is cheap to reverse now and expensive after the reports exist.

1. **Cash sales count.** A bucket that left on a cash invoice is still out. The
   container balance therefore does NOT reconcile against receivables, and the
   report must not be read as money owed.
2. **`CONTAINER_OUT` is in scope.** Crates to companies can be lent without a
   sale, so the derived-from-sales side is not sufficient on its own.
3. **No deposit value.** Containers are tracked as quantities, not charged for.
   If a deposit is ever wanted, it is a new `deposit_value` column and a journal
   posting — deliberately not built now, and nothing here blocks it.
4. **Balances are per (customer, container product).** A customer holding 7
   halloumi buckets and 2 crates is two rows, never one total.
5. **A container movement is not a visit.** `VISIT_KINDS`
   (`vouchers.service.ts:99`) stays `SALE`/`RETURN`/`ORDER`. Collecting empties
   is not a sales call and must not inflate visit coverage.

---

## 3. Gates — nothing appears until it is switched on

Four layers, each following a pattern that already exists in its codebase.

| Layer | Where | Controls |
|---|---|---|
| ERP org feature | `organizations.containers_enabled`, beside `allow_negative_warehouse_stock` (`schema.ts:25`) | Whether the container fields and the ERP report exist at all |
| ERP screen permission | New key `inventory.containers` in `ERP/src/lib/screen-registry.ts` → `user_screen_permissions` | Whether a given ERP user sees the report page |
| VanFlow org feature | `app_settings.containers_enabled` → `settings.service.ts` → `GET /company-info` → app `SessionStore` | Mirrors `damagedReturnsEnabled` exactly, so it holds offline |
| Rep permission | `users.can_handle_containers` → `auth.service.ts` permissions map → app `SessionStore` | Whether the rep sees the container actions |

The rep action requires **both** the VanFlow org flag and the rep permission, so
switching the feature off at the office hides it from everyone regardless of
what was granted. Defaults: every flag `false`, the permission opt-in. Per
SYSTEM-OVERVIEW §4.4 this is the "gives something away" kind of permission, so a
server that has not heard of it must not grant it by omission.

### The validation that makes the permission safe

`CONTAINER_IN` / `CONTAINER_OUT` must refuse any line whose item is not
`is_returnable_container`. Without it, `can_handle_containers` becomes a way to
move *any* product into the van at zero value with no approval. This single
check is what makes the permission safe to hand out freely, and it gets its own
test.

---

## 4. Work breakdown

### Phase 1 — ERP: the catalogue half

Everything else depends on the product→container link existing and reaching
cash-van.

1. Migration: three `products` columns + `organizations.containers_enabled`;
   FK on `container_product_id` added in the migration, not inline, to avoid the
   circular reference (same reason as `tobacco_tax_profile_id`).
2. `src/db/schema.ts` — the columns.
3. Product form (`/dashboard/inventory` product editor): a "Returnable
   packaging" section — the `is_returnable_container` switch, and for an ordinary
   product a container picker + containers-per-unit. AR/EN both, per the ERP
   i18n rule.
4. `GET /api/v1/skus` (`src/app/api/v1/skus/route.ts`) — carry the three fields
   on the resolved SKU→product payload, exactly as it already carries
   `isTobaccoProduct`.
5. Guard: a product may not be its own container, and a container may not itself
   carry a container (one level only).

### Phase 2 — cash-van: the document

6. TypeORM migration: `item_cart.is_returnable_container`,
   `item_cart.container_item_number`, `item_cart.containers_per_base_unit`;
   `app_settings.containers_enabled`; `users.can_handle_containers`;
   `container_movements` table.
7. `erp-sync.service.ts` — extend `ErpSku` (~line 170) and the item upsert
   (~line 4823) to carry the three fields through. Container links arrive as
   `container_item_number`, resolved from the ERP product id through the existing
   id map.
8. `transaction_kinds`: add `CONTAINER_IN` (sign +1) and `CONTAINER_OUT`
   (sign −1) to `STANDARD_TRANS_KINDS` (`vouchers.service.ts:164`) so a clean
   database can post them.
9. `VAN_EFFECT`: `CONTAINER_IN: 'in'`, `CONTAINER_OUT: 'out'`.
   `VOUCHER_PREFIX`: `CIN` / `COUT`.
10. `enforceSalesmanPolicy` (`vouchers.service.ts:2099`): the new kinds require
    `can_handle_containers`; the RETURN gate is untouched.
11. Line validation: every line's item must be `is_returnable_container`, and
    `unitPrice` must be `0`. A non-zero price is rejected rather than ignored —
    silently zeroing it would hide a mispriced document.
12. The balance query, as a service + a view: base pieces sold × per-unit, plus
    OUT, minus IN, grouped by (customer, container item). Must use **base
    pieces** (`item_qty × unit_base_qty`), not line quantity — a line can be a
    carton of four.
13. `GET /containers/balances` (by customer, by rep, by container) and
    `GET /customers/:id/containers`.
14. Outbox: `OUTBOX_KIND_BY_TRANS` (`outbox-enqueue.ts:13`) gains
    `CONTAINER_IN`/`CONTAINER_OUT` → `CONTAINER_MOVEMENT`, plus the builder.
15. `/company-info` carries `containersEnabled`; the permissions map carries
    `canHandleContainers`.

### Phase 3 — ERP: the ledger half and the report

16. `container_movements` table — org, customer, salesman, container product,
    qty, direction, date, source voucher number. Receives what cash-van pushes;
    `stock_adjustments` cannot be reused because it has no customer
    (`schema.ts:1048`).
17. `POST /api/v1/container-movements` — idempotent on the source voucher
    number, like the other v1 write endpoints.
18. The stock side: a container movement posts a `stock_movements` row so
    `item_stock` tracks empties per warehouse like any other item.
19. Report page `/dashboard/inventory/containers` + screen key
    `inventory.containers`: outstanding by customer, by salesman, by container
    type, **with aging** — days held is the column the office acts on.
20. The ERP's own derivation of the outbound side from `invoice_items`, so both
    systems compute the same balance from the same rule.

### Phase 4 — dashboard (frontend)

21. Container balances screen, modelled on the existing reports screens.
22. The container panel on the customer page.
23. The `can_handle_containers` switch on the user permissions form.
24. The `containersEnabled` switch on the settings page.

### Phase 5 — FlowVan app

25. `item_cart` mirror columns in Room + a schema migration.
26. `containersEnabled` + `canHandleContainers` in `SessionStore`/`SettingsKeys`.
27. `CreateContainerMovementUseCase`, offline-first and queued through the
    existing sync path like every other document.
28. Customer dashboard: an "إرجاع فوارغ" tile, hidden unless the flag and the
    permission are both on (`CustomerDashboardViewModel.kt:55` is the pattern),
    showing what this customer holds.
29. A container-balances report screen, server-first with a device fallback and
    an origin label, following `voucherReportRows()`/`RepVoucherSource`.
30. Receipt: a small container slip, so the customer has something signed.

---

## 5. Tests

- **Allocation-free balance arithmetic** — pure function, the per-unit
  multiplication, and a carton line that must count 4 containers and not 1.
- **The container-only validation** — a `CONTAINER_IN` naming an ordinary
  product is rejected. This is the security test for the permission.
- **Non-zero price rejected.**
- **The permission gate** — no `can_handle_containers` → refused; the RETURN
  gate still behaves exactly as `discount-policy.spec.ts` asserts today.
- **Both flags required** — org flag off hides the action even when granted.
- **No credit, no debt** — a container movement leaves the customer's balance
  and the rep's cash position untouched (the invariant in
  `returns-are-credit.spec.ts`).
- **Not a visit** — a container movement does not create a `customer_visits` row.
- **Outbox** — a container movement enqueues `CONTAINER_MOVEMENT`; replaying the
  same voucher number is idempotent on the ERP.
- **One level only** — a container may not carry a container.

## 6. Deployment

Both clients (**77** = 77.245.5.113, **94** = 94.142.51.91) run ERP + cash-van
together, so the two migrations go in the same window: the ERP's first (the
catalogue is the dependency), then cash-van's. Per the 77 runbook there is no
migrate service on that host and migrations are run by hand; the dashboard image
must be retagged `vanflow-dashboard:prod` after loading.

The feature ships **off**. Switch on per client: ERP org flag → create the
container products with zero price and an exempt tax rate → link them to the
products that ship in them → grant `inventory.containers` → VanFlow org flag →
grant the rep permission. Until the container products exist and are linked,
every balance is legitimately zero and nothing changes for anyone.

## 7. Risks

- **Reps will not collect what they cannot see.** The balance has to be on the
  customer dashboard before the rep knocks, not only in a report at the office.
  Treat item 28 as part of the core, not polish.
- **The derived outbound side moves when history is edited.** Cancel or amend an
  invoice and the containers-out figure changes with it. That is correct, and it
  means the report is a live view and not a ledger — the aging column must be
  computed from invoice dates, not from a snapshot.
- **A container product with the wrong tax rate.** `products.tax_rate_id` is NOT
  NULL, so each container needs an exempt/zero rate. A container accidentally
  linked to a 16% rate would do nothing at zero price, but would surface if a
  deposit is ever added.
- **Two derivations of one number.** cash-van and the ERP each compute the
  outbound side from their own invoice lines. They must agree, so the rule lives
  in one documented place and both implementations cite it.
