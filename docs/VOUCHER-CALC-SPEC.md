# Voucher Money Spec — Tax & Discounts (Jordan)

The **single source of truth** for SALE/RETURN money math across all three systems:
the **FlowVan app**, the **dashboard backend**, and the **ERP**. A given voucher MUST
produce identical numbers in all three. Reference implementation +
machine-checked fixtures: `src/modules/vouchers/voucher-calc.ts` and
`voucher-calc.spec.ts`.

## Units & rounding
- All money is integer **fils** (JOD × 1000). JOD has 1000 fils → **3 decimals**.
- Round **half-up to the nearest fil** (`Math.round`) at every step listed below.
- Quantities may be fractional; `gross = round(unitPrice × qty)`.
- Storage: `numeric(14,3)` everywhere (backend totals were `(14,2)` — migrated to `(14,3)`).

## Tax modes (per voucher, from settings)
- **EXCLUSIVE** ("excluded") — `unitPrice` is pre-tax; tax is **added on top**.
- **INCLUSIVE** ("included") — `unitPrice` already contains tax; tax is **extracted**.
- Backend reads `app_settings.tax_calc_method`; ERP reads `organizations.sales_tax_mode`;
  app reads `taxType` from `GET /company-info`. All three must agree per voucher.

## Discounts
- **Line discount** = percentage **and/or** fixed value (both stack), clamped to the line gross.
- **Header (voucher) discount** = ONE discount, percentage **or** fixed value, applied to the
  **pre-tax net** and **distributed across lines by net share**. Tax is computed on each
  line's net **after** its header-discount share. The rounding remainder of the distribution
  is placed on the **last line with net > 0** so shares sum exactly to the header discount.

## Algorithm (per line, then voucher)
```
# 1. line gross + line discount (% then fixed, stacked)
gross            = round(unitPriceFils × qty)
lineDiscount     = clamp( round(gross × lineDiscountPct/100) + lineDiscountFils , 0, gross )
netBeforeHeader  = gross − lineDiscount

# 2. header discount over the whole voucher, distributed by net share
sumNet        = Σ netBeforeHeader
headerDisc    = clamp( headerPct>0 ? round(sumNet × headerPct/100) : headerFils , 0, sumNet )
share_i       = round( headerDisc × netBeforeHeader_i / sumNet )      # remainder → last line
net_i         = netBeforeHeader_i − share_i

# 3. tax (after discounts)
EXCLUSIVE:  taxable = net ;                         tax = round(net × rate/100) ;  total = net + tax
INCLUSIVE:  taxable = round(net × 100/(100+rate)) ; tax = net − taxable ;          total = net

# 4. voucher totals
totalNet   = Σ taxable          # tax base
totalTax   = Σ tax
grandTotal = Σ total            # always == totalNet + totalTax
totalDiscount = Σ lineDiscount + headerDisc
```

## Returns
A RETURN references its original SALE and **pro-rates** each original line's
`net / tax / total / discount` by `returnedQty ÷ billedQty` (`round` each).
This is what the ERP already does and guarantees a return can never diverge from
its sale (no re-pricing, inherits the sale's inclusive/exclusive treatment).

## Cross-system parity (export app → dashboard → ERP)
- **App** computes locally (offline) with this spec for display; sends canonical inputs
  (`unitPrice`, `qty`, `lineDiscountPct`, `lineDiscountFils`, `headerDiscount{Pct|Fils}`,
  `taxMode`, per-line `taxRatePct`). It does **not** send a reconciliation residual.
- **Dashboard backend** is authoritative: recomputes from the same inputs with this engine
  and stores the resolved `net/tax/total/discount`.
- **ERP** recomputes too. To make its result identical, the dashboard→ERP push sends, per line:
  `unitPrice`, `quantity` (base pieces), `taxRateId` (mapped from the line's rate%), and
  `discount = lineDiscountFils + headerShareFils` (the line's full discount incl. its header
  share, in JOD). The ERP's `calculateLineTax` uses the same `round`-to-fil formula, so its
  `net`/`tax`/`lineTotal` match the dashboard's exactly.

## Worked examples (fixtures)
| Mode | Lines (unitPrice×qty, rate) | Discount | Net | Tax | Grand |
|---|---|---|---|---|---|
| EXCL | 1.000×2 @16% | — | 2.000 | 0.320 | 2.320 |
| INCL | 1.160×1 @16% | — | 1.000 | 0.160 | 1.160 |
| EXCL | 1.000×1 @16% | line 10% | 0.900 | 0.144 | 1.044 |
| EXCL | 1.000×1 @16% | line 10% + 0.050 | 0.850 | 0.136 | 0.986 |
| EXCL | 1.000 + 2.000 @16% | header 10% | 2.700 | 0.432 | 3.132 |
| EXCL | 1.000×3 @16% | header 0.100 fixed | 2.900 | 0.465 | 3.365 |
| INCL | 1.160×1 @16% | header 0.160 fixed | 0.862 | 0.138 | 1.000 |
