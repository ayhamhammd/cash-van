# Tobacco ("Smoke") Tax — Full Implementation Plan

**Goal:** mirror the ERP's tobacco tax feature in FlowVan (backend + dashboard) and the
mobile app, so a van sale of a tobacco item computes the exact same tax the ERP would,
online or offline, and pushes the full snapshot back to the ERP.

**Source of truth studied:** `ERP/src/lib/tobacco-tax-engine.ts` (+ schema
`tobacco_tax_profiles`, products/SKU fields, `DirectInvoiceClient` sales flow,
`/api/v1/skus` exposure). This plan mirrors it 1:1 — same field names, same rounding.

---

## 1. How the ERP tobacco tax works (verified behavior)

### 1.1 The profile (`tobacco_tax_profiles`)
Org-scoped, effective-dated, three independent components. All money = **integer
thousandths** (= our fils). Rates = plain integer percent (13 = 13%).

| Component | Config | Calculation |
|---|---|---|
| **Sales tax** | `salesTaxEnabled`, `salesTaxRate`, `taxBase: SALE_PRICE \| CONSUMER_PRICE` | `round(base × rate / 100)` where base = qty × unitPrice or qty × consumerPrice |
| **Special (excise)** | `specialTaxEnabled`, `specialTaxCalculationType: NONE \| FIXED_PER_UNIT \| RATE \| FIXED_PLUS_RATE`, `specialTaxBase: SALE_PRICE \| CONSUMER_PRICE \| QUANTITY`, `specialTaxRate`, `specialTaxFixedAmount` (fils/unit) | FIXED: `fixed × qty` · RATE: `round(base × rate / 100)` · FIXED_PLUS_RATE: both |
| **Withheld (prepaid)** | `withheldTaxEnabled`, `withheldTaxCalculationType: NONE \| FIXED_PER_UNIT \| RATE`, `withheldTaxBase: SALE_PRICE \| CONSUMER_PRICE \| GROSS_TAX`, `withheldTaxAmount` (fils/unit), `withheldTaxRate` | FIXED: `amt × qty` · RATE: `round(base × rate / 100)` |

Derived: `grossTax = salesTax + specialTax` · `netTax = max(grossTax − withheldTax, 0)`.

Also on the profile: `taxIncludedInConsumerPrice` (bool), 3 accounting account
mappings (sales-tax payable / special-tax payable / withheld-tax asset),
`effectiveFrom/To`, `isActive`.

Worked example (from the ERP spec): qty=10, unitPrice=2000, consumerPrice=2500,
salesTaxRate=13% on CONSUMER_PRICE, specialFixed=600/unit, withheldFixed=400/unit →
salesTax=3250, special=6000, withheld=4000, **gross=9250, net=5250**.

### 1.2 Item flags
- **Product:** `isTobaccoProduct`, `tobaccoTaxProfileId`, `consumerPrice` (MSRP, fils).
- **SKU override:** same 3 fields (`isTobaccoProduct: null` = inherit product) +
  `allowTobaccoTaxOverride`.
- v1 `GET /skus` already returns the **resolved** trio per SKU (+ `?tobacco=true` filter).

### 1.3 Sales behavior (the part that changes tax calculation)
For a line whose item is tobacco (with a profile):
1. **Normal GST is completely bypassed** — the line's tax = tobacco `netTaxAmount`.
2. `lineTotal = (qty × price − discount) + netTax` — tobacco tax is **always added on
   top**, the org's INCLUSIVE/EXCLUSIVE tax mode does **not** apply to tobacco lines.
3. Tax-free customers (export / free-zone / transit / development-area) → tobacco tax
   is 0 too (line is fully tax-free).
4. The invoice line stores a **full snapshot**: `isTobaccoLine, tobaccoTaxProfileId,
   consumerPrice, consumerValue, tobaccoTaxBaseAmount, tobaccoSalesTaxRate,
   tobaccoSalesTaxAmount, tobaccoSpecialTax{CalcType,Rate,Fixed,Amount},
   tobaccoWithheldTax{CalcType,Rate,Fixed,Amount}, tobaccoGrossTaxAmount,
   tobaccoNetTaxAmount, tobaccoCalcDetails(json)` — history never changes when a
   profile is edited later.
5. Totals UI shows a tobacco breakdown row: sales / excise / withheld / net.

### 1.4 Gaps found in the ERP (must fix there first)
- **No v1 API for tobacco profiles** — FlowVan can see an item IS tobacco + its
  `tobaccoTaxProfileId` + `consumerPrice`, but cannot fetch the profile parameters.
- **v1 `POST /sales-invoices` does not accept the tobacco snapshot fields** — a van
  sale pushed today would lose the breakdown (and the ERP would re-tax at plain GST).

---

## 2. Current FlowVan state (what must change)

| Layer | Today | Gap |
|---|---|---|
| Backend `item_cart` | `taxType/taxCategory/taxRate/taxPercentage` (GST only) | no tobacco flag/profile/consumerPrice |
| Backend `voucher-calc.ts` | canonical GST engine (EXCLUSIVE/INCLUSIVE + discounts) | no tobacco path |
| Backend ERP sync (in) | `pullItems` maps sku/name/price/cost/units/image only | ignores `isTobaccoProduct/tobaccoTaxProfileId/consumerPrice` already present in `/skus` |
| Backend ERP push (out) | sale lines → `taxRateId` resolved from `taxPercentage` | no tobacco snapshot |
| `voucher_transactions` | `taxPercentage` per line | no tobacco snapshot columns |
| Dashboard | item form, voucher views, tax page — GST only | no profile viewer, no breakdown |
| App `Product` | `taxRate: Double` only | no tobacco fields |
| App `VoucherCalc`/`InvoiceTaxCalculator` | Kotlin twin of backend GST engine | no tobacco path |
| App receipt (voucher template) | GST tax rows | no tobacco breakdown rows |

---

## 3. Implementation plan

### Phase 0 — ERP additions (prerequisite, small) — ✅ DONE (2026-07-02)
1. **`GET /api/v1/tobacco-tax-profiles`** ✅ — scope `products:read` (no `catalog:read`
   scope exists in the ERP). Returns active profiles, all §1.1 params; per-unit fixed
   amounts in JOD major (`money()`), rates as integer %. File
   `ERP/src/app/api/v1/tobacco-tax-profiles/route.ts`.
2. **Extended v1 `POST /sales-invoices`** ✅ — line schema gains optional
   `isTobaccoLine`, `tobaccoTaxProfileId`, `consumerPrice` (additive, non-breaking).
   **Design refinement vs. original plan:** instead of trusting a client-sent snapshot,
   the ERP **re-computes authoritatively** from the profile (`calculateTobaccoTax`) —
   the caller only flags the line + names the profile + supplies consumer price. This
   is safer for the accounting master and means FlowVan needn't send the computed
   amounts. Tobacco lines: `taxRateId` ignored, `taxAmount = netTax`,
   `lineTotal = gross + netTax` (GST bypassed, added on top); the full snapshot is
   frozen onto `invoice_items`. Unknown/inactive profile → 400.
3. `GET /skus` — no change needed (already resolved). ✔
4. Verification: contract test `ERP/src/lib/__tests__/tobacco-invoice-line.test.ts`
   (spec example net=5.250, discount-before-tax, withheld clamp) — 28 tobacco tests
   pass; typecheck introduced 0 new errors; OpenAPI doc updated.

> **FlowVan-side note (Phase 2):** the outbound push must send only
> `isTobaccoLine/tobaccoTaxProfileId/consumerPrice` per line (NOT `taxRateId`) — the
> ERP does the authoritative tax math. Consumer price is sent in JOD major.

### Phase 1 — FlowVan backend: schema + engine — ✅ DONE (2026-07-02)
Migration `1720400000000-TobaccoTax` (all 4 changes); engine port
`src/modules/vouchers/tobacco-tax-calc.ts` (+ `.spec.ts`, byte-identical vectors to
ERP); `TobaccoTaxProfile` entity `src/modules/items/entities/`; item + voucher-line +
app_settings columns; `VouchersService.createUnchecked` integration
(`resolveTobaccoLines` + GST-bypass + net-on-top + header totals + snapshot).
**Decisions made:** tobacco applied on **SALE only** when the master toggle is ON
(RETURN/ORDER deferred); tobacco tax computed on **BASE PIECES**
(`quantity = qtyOfUnit × unitBaseQty`, unit/consumer prices per piece) so per-pack
excise is correct — exact for unitBaseQty=1, per-piece-accurate for larger units.
Verified: 18 jest tests + a real HTTP sale (toggle ON → net 265 fils persisted with
full snapshot; toggle OFF → `is_tobacco_line=false`, plain GST). Details below stand
as the as-built record.

1. **Migration `TobaccoTax`**:
   - `tobacco_tax_profiles` table — mirror of the ERP shape (id uuid PK, erp_id text
     unique nullable, name, description, tax_base, the 3 component blocks,
     tax_included_in_consumer_price, effective_from/to, is_active, timestamps).
     No accounting-account columns (FlowVan has no CoA; ERP posts the accounting).
   - `item_cart`: `is_tobacco_product boolean NOT NULL DEFAULT false`,
     `tobacco_tax_profile_id uuid NULL`, `consumer_price_fils integer NULL`.
   - `voucher_transactions`: the full snapshot columns from §1.3.4
     (`is_tobacco_line boolean NOT NULL DEFAULT false`, amounts integer fils
     DEFAULT 0, types/rates nullable, `tobacco_calc_details jsonb NULL`).
   - `app_settings`: `tobacco_tax_enabled boolean NOT NULL DEFAULT false` — the
     master toggle ("if turned on"). OFF ⇒ everything behaves exactly as today.
2. **Port the engine 1:1** → `src/modules/vouchers/tobacco-tax-calc.ts`:
   copy `calculateTobaccoTax` + types verbatim (thousandths = fils, same rounding
   `Math.round`). Port the ERP's `tobacco-tax-engine.test.ts` cases into
   `tobacco-tax-calc.spec.ts` — numbers must match exactly (incl. the §1.1 example).
3. **Voucher posting** (`vouchers.service`): when `tobacco_tax_enabled` and the
   line's item is tobacco with a resolvable active profile → compute the snapshot,
   set line tax = `netTax` (bypass GST for that line, added on top regardless of
   `taxCalcMethod`), store the snapshot. Non-tobacco lines unchanged. Reuse the
   ERP rule: no profile/consumerPrice missing → reject with a clear 400.

### Phase 2 — FlowVan backend: sync + push — ✅ DONE (2026-07-02)
`ErpSku` extended + `pullTobaccoProfiles()` (before items, in syncNow + refreshAll;
fils conversion; id-map entity `'tobacco_profile'`); `upsertProductItem` maps the
resolved tobacco fields (ERP profile id → local id via `erpId`, consumer price →
fils). Outbound `buildSale` sends `isTobaccoLine`/`tobaccoTaxProfileId`(local→ERP
id via `erpTobaccoProfileId`)/`consumerPrice`(major) and **no `taxRateId`** for
tobacco lines. Local CRUD: `TobaccoTaxProfilesController/Service` in ItemsModule —
GET any-auth, writes admin + `ErpReadOnlyGuard` (403 when ERP on). **Gap fixed:**
the tobacco toggle was ERP-read-only-blocked; added a dedicated `PATCH
/settings/tobacco-tax` (admin, NOT ERP-guarded) since it's a local feature flag.
**Learning:** to flag a tobacco item the ERP SKU must be tobacco OR inherit (null)
— a SKU-level `false` override wins over the product flag (correct ERP behavior).
Verified cross-system: profile synced (fils), item auto-flagged (local profile),
posted tobacco sale pushed → **ERP re-computed byte-identically** (net 525 fils);
81 jest tests pass; test data cleaned from both DBs.

1. **Inbound** (`erp-sync.service`):
   - Extend `ErpSku` with `isTobaccoProduct/tobaccoTaxProfileId/consumerPrice`; map
     them in `upsertProductItem` (consumerPrice major → fils).
   - New `pullTobaccoProfiles()` in the sync cycle + `refreshAll` (entity
     `tobacco_profiles`, id-mapped via `erp_id_map` entity `'tobacco_profile'`).
     ERP-managed mode ⇒ profiles are read-only in FlowVan (same rule as items).
2. **Outbound** (`erp-outbox.service` `buildSale`): include the per-line snapshot
   fields (fils → major where money) so the ERP invoice carries the same breakdown.
   Tobacco lines send **no `taxRateId`** (the ERP must not re-apply GST).
3. Standalone mode (ERP off): profiles are CRUD-able locally (service + controller,
   admin-only), same validation as the ERP zod schema.

### Phase 3 — Dashboard (frontend)
1. **Settings → new "Tobacco Tax" tab**: master toggle + profile list (read-only
   badge when ERP-managed; editable standalone). Show the 3 components compactly.
2. **Item form**: "Tobacco product" toggle → profile select + consumer price input
   (fils ↔ JOD). Hidden while the master toggle is off; read-only when ERP-managed.
3. **Voucher detail / new-voucher preview**: tobacco lines show `نتج ضريبة التبغ`
   line-tax and a totals breakdown block (sales / excise / withheld / net) — mirror
   the ERP totals card. Tax page (JoFotara ledger) counts tobacco `netTax` in the
   voucher's tax total (it already reads the stored line tax, so this is mostly free).
4. i18n: all new strings AR+EN in `dictionaries.ts`.

### Phase 4 — Mobile app (KMP)
1. **Model/DB/DTO**: `Product` + `ProductEntity` + `ProductDto` + mappers gain
   `isTobaccoProduct: Boolean`, `tobaccoTaxProfileId: String?`,
   `consumerPriceFils: Long?`. New `TobaccoTaxProfile` model + entity + DAO; synced
   from the backend (`GET /tobacco-tax-profiles` — new BFF endpoint, any auth) on
   catalog sync, cached for offline.
2. **Engine**: port `calculateTobaccoTax` to Kotlin next to `VoucherCalc`
   (`TobaccoTaxCalc.kt`, pure, integer fils). Extend `CalcLineInput` with an optional
   tobacco context; inside `VoucherCalc`, a tobacco line's tax = netTax added on top
   (bypass INCLUSIVE/EXCLUSIVE), matching the backend/ERP exactly. Port the same
   test vectors (spec parity across all three engines).
3. **Cart/summary UI**: tobacco items badge; totals bottom sheet shows the tobacco
   breakdown; the settings master toggle arrives via `/company-info` or app-settings
   sync so the app knows whether to apply it.
4. **Receipt**: voucher template gains `showTobaccoBreakdown` (add-only, v2 template
   contract §9 rules) — rows for sales/excise/withheld/net under the tax row.
5. **Voucher upload**: include the snapshot fields in the voucher DTO so the backend
   stores exactly what the salesman saw offline (backend re-computes + validates;
   mismatch ⇒ reject, same as money validation today).

### Phase 5 — Verification & rollout
1. **Spec parity tests**: one shared table of vectors (incl. the §1.1 example +
   FIXED_PLUS_RATE + RATE-on-GROSS_TAX withheld + `netTax` clamp at 0) run in:
   ERP jest, backend `tobacco-tax-calc.spec.ts`, app Kotlin test.
2. Backend e2e: post a mixed voucher (tobacco + normal + discounts) in both tax
   modes; assert stored snapshot + ERP outbox body.
3. Deploy order: **ERP first** (new API + invoice fields) → FlowVan backend
   (migration auto-runs on Render `start:deploy`) → dashboard → app release.
   The master toggle stays OFF until profiles are synced and verified.
4. Docs: update `VOUCHER-CALC-SPEC.md` with the tobacco path; memory note.

---

## 4. Design decisions (locked)
1. **Bypass, don't stack**: tobacco netTax *replaces* GST for that line (ERP behavior).
2. **Always tax-on-top** for tobacco lines, in both INCLUSIVE and EXCLUSIVE modes.
3. **Snapshot at sale time** — profile edits never rewrite history.
4. **Integer fils everywhere**, `Math.round` at each component — byte-identical math
   in ERP TS, backend TS, app Kotlin.
5. **Master toggle OFF by default** — zero behavior change until enabled.
6. ERP-managed ⇒ profiles + item tobacco fields are read-only in FlowVan (ERP is
   master, same as the rest of base data).
