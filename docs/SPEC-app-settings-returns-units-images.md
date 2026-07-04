# Spec — FlowVan app: read-only settings, logo, item images, unit-price fallback, server-driven returns

Status: **DRAFT for approval** · Scope: FlowVan app (KMP) + cash-van backend (NestJS). ERP unaffected.

This spec covers five linked edits requested for the salesman app:

1. Settings page becomes **view-only** (company info, tax type, permissions, logo — all from the API); **only the server IP/connection is editable**.
2. Show the **company logo**.
3. Show the **item image in the item list**.
4. **Unit-price fallback**: a unit with no price → `unit price = unit_qty × item base price`.
5. **Returns are fully server-driven**: list only this customer's sale vouchers from the server, load the chosen sale's lines from the server, and the **remaining returnable quantity per line is computed by the API** (sold − already-returned across prior returns of that sale), live, **without mutating the sale**.

---

## 1) Settings page — view-only except IP/connection

### Goal
The settings screen should present server-owned data (company info, tax mode, permissions, logo) as **read-only**, sourced from the API on open. The salesman may only change the **server IP / base URL** (and connect/test). Everything else reflects what the dashboard/ERP set.

### Current state
- `feature/home/.../SettingsScreen.kt` + `SettingsViewModel.kt` currently let the salesman edit, locally: theme, language, **tax type**, IP/baseURL, salesman number/branch, voucher-number limits, and permission toggles (`canEditPrice`, `offlineModeEnabled`). None of the company/tax/permission values come from the server here.
- The API already exposes everything needed:
  - `GET /company-info` → `{ companyNameAr, companyNameEn, sellerTin, sellerAddress, sellerPhone, sellerCityCode, logoUrl, taxCalcMethod, timezone, locale }` (`SettingsService.getCompanyInfo`).
  - `GET /auth/me` → `{ …, role, permissions: Map<String,Boolean>, permKeys: string[] }` (fresh from DB).
  - App DTOs already exist: `CompanyInfoDto` (has `logoUrl`, `taxCalcMethod`) and `MeDto` (has `permKeys`). `RefreshCatalogUseCase` already pulls both on home open.

### Required behaviour
Restructure the settings screen into two regions:

**A. Connection — EDITABLE (the only editable section)**
- Server IP / base URL field → writes `ApiConfig.baseUrl` (existing setter in `SettingsViewModel.save()`), plus the existing Test/Connect action.
- Keep the work-with/without server toggle if present (`ApiConfig.isEnabled`).

**B. Company & policy — READ-ONLY (from API, fetched on open)**
- Company name (ar/en) + **logo** (see §2).
- Tax type / mode — show `companyInfo.taxCalcMethod` (`INCLUSIVE`/`EXCLUSIVE`), read-only. Remove the local tax-type editor; the app's tax mode is already synced by `syncCompanyTaxMode()`.
- Seller TIN / address / phone / city — read-only.
- **Permissions** — render `MeDto.permKeys` as a read-only checklist/badges (granted keys: `vouchers.discount.direct`, `vouchers.priceOverride`, `vouchers.return.create`, `vouchers.return.approval`, `customers.visitReason`, …). No toggles.
- Salesman number / branch / role — read-only (from session / `MeDto`).

**C. Display preferences — device-local (decision point)**
- Theme + language are device UX prefs, not server data. **Recommendation:** keep them editable in a separate "Display" section (they are not "settings from the API"). If you want strictly "only IP editable", move them out of Settings entirely. **Open question — confirm.**

### Data fetch
- On screen open, the ViewModel calls `AuthApi.companyInfo()` + `AuthApi.me()` (or reuses the values `RefreshCatalogUseCase` already cached). Show a small "synced from server" caption + last-sync time. Read-only fields never write back.

### Backend changes
- Add `sellerCityCode` to the app's `CompanyInfoDto` (backend already returns it). No backend logic change.

### Acceptance
- Opening Settings shows company name, logo, tax mode, TIN/address/phone, and the granted permission keys — none editable.
- Only the IP/base-URL (and connect/test) can be changed and persists to `ApiConfig`.
- Changing nothing server-owned is possible from the app.

---

## 2) Company logo

### Goal
Display the company logo in the app (settings header, and optionally the home top bar + printed receipt header).

### Current state
- `CompanyInfoDto.logoUrl` already exists and is returned by `GET /company-info`. The logo is stored on `app_settings.logo_url` and synced from the ERP/dashboard. Coil 3 is already a dependency (added for item images).

### Required behaviour
- Persist `logoUrl` locally (extend `AppSettings`/`AppSettingsEntity` in the app with a nullable `logoUrl`, set during `syncCompanyTaxMode()`/company-info sync — Room schema bump).
- Render it with Coil `AsyncImage` where a brand mark helps: Settings header (required), home top bar (optional), receipt/print header (optional). Fallback to the app name text when `logoUrl` is null.

### Backend changes
- None (logo already served). Ensure the URL is absolute (it is — `applyErpOrg` stores what the dashboard sends; if a relative path ever appears, resolve against the server origin like item images do).

### Acceptance
- When a logo is set on the dashboard/ERP, it appears in the app settings header; when absent, the app name shows.

---

## 3) Item image in the item list

### Goal
Show each item's image in the app's **item/stock list** (not only the add-to-voucher picker, which already shows it).

### Current state
- `GET /products` already returns `imageUrl` per item (absolute URL) and the `units` array.
- App `Product.imageUrl` is mapped end-to-end; the voucher picker row, cart line, cart card, and van-stock card already use `ProductThumb` (image → avatar fallback).

### Required behaviour
- Audit every screen that lists items and ensure it uses `ProductThumb(imageUrl = product.imageUrl, …)`:
  - Van-stock list (`VanStockScreen` `StockCard`) — **done** (photo when present, category icon otherwise).
  - Any standalone catalog/browse list — apply `ProductThumb`.
  - The add-item bottom sheet **hero/preview** image: the live screen is `VoucherScreen` (the `SaleVoucherScreen` variant is dead). Replace the letter-avatar hero with `AsyncImage(product.imageUrl)` + fallback so the selected item shows its photo.

### Backend changes
- None (imageUrl already in `/products`).

### Acceptance
- Items with an image show the photo in every list and in the add-item sheet header; image-less items show the existing avatar/icon.

---

## 4) Unit-price fallback (no price → qty × base price)

### Goal
If a sellable unit has **no price** (price is null/0), its price must be derived: `unit price = unit_qty (conversionQty) × item base price`. (e.g. base حبة = 0.350; a طرد of 30 with no price → 30 × 0.350 = 10.500.)

### Current state
- Backend `ProductsService.attachUnits()`: base unit `priceFils = item.price`; larger unit `priceFils = round(item_unit.salePrice × 1000)` — which is **0 when `salePrice` is unset**.
- App `ProductUnit.price` is used directly (no fallback) when computing the line gross.

### Required behaviour (apply in BOTH places — server is source of truth, app is the safety net)
- **Backend** (`attachUnits`): when a larger unit's `salePrice` ≤ 0, set
  `priceFils = round(item.price × conversionQty)` (item.price is already fils; conversionQty = pieces per unit). Base unit keeps `item.price`.
- **App** (`VoucherViewModel` / `AddItemBottomSheet` unit selection): defensive fallback — if `selectedUnit.price <= 0`, use `product.salePrice × selectedUnit.conversionQty`.

### Edge cases
- Base unit (conversionQty = 1) → fallback equals base price (no change).
- A unit that genuinely should be free is not supported (0 is treated as "unpriced"); document this — pricing a unit at exactly 0 is out of scope.

### Acceptance
- Selecting a no-price unit yields a non-zero line total equal to `conversionQty × base price`; a priced unit uses its own price unchanged.

---

## 5) Returns — server-driven, with live returnable-qty calculation

This is the largest change.

### Goals
1. The return screen lists **only this customer's SALE vouchers**, fetched **from the server** (no local-invoice source).
2. The chosen sale's **lines are loaded from the server**.
3. The **remaining returnable quantity per line is computed by the API**, live, as
   `remaining = sold − Σ(already-returned across prior RETURN vouchers that reference this sale)`,
   **without modifying the sale voucher**.

### Edge case (the key one)
A salesman returns some items from sale `S`. Later they start another return against the **same** sale `S`. The second return must offer **remaining = sold − previously-returned** for each line — computed at request time, not by editing `S`. Quantities are aggregated in **base pieces** so mixed units (sold by طرد, returned by حبة) net correctly.

### Current state
- `referenceVoucherNumber` on `VoucherHeader` links a RETURN to its SALE. There is **no** endpoint/logic that computes remaining returnable qty.
- App: `GetCustomerSalesUseCase.customerSales(customerNumber)` (list) + `saleByNumber(...)` + `voucherDetail(id)` (lines) exist. The return VM also has a **local** invoice source (`selectSourceInvoice`) and caps using `soldQtyByProduct` from the local sale only — this misses prior returns and isn't server-authoritative.

### New backend API

**`GET /vouchers/:idOrNumber/returnable`** (any authenticated salesman; resolve by id or by `voucherNumber` + `customerNumber`).

Computes, live, per line, in **base pieces**:

```
sale            = SALE header (by id or voucherNumber) + transactions
priorReturns    = all RETURN voucher headers (isPosted = true) + transactions
                  WHERE referenceVoucherNumber = sale.voucherNumber
returnedByItem  = map<itemNumber, Σ itemQty(base)>  over priorReturns' transactions
for each sale line L (aggregated by itemNumber):
    soldBase      = Σ L.itemQty (base pieces)
    returnedBase  = returnedByItem[L.itemNumber] ?? 0
    remainingBase = max(0, soldBase − returnedBase)
```

Response:
```jsonc
{
  "voucherNumber": "INV-2026-WH-20c69c-12",
  "customerNumber": "ERP-9af3d083",
  "inDate": "2026-06-20T…",
  "taxCalcMethod": "EXCLUSIVE",          // so the app prices the return the same way
  "lines": [
    {
      "itemNumber": "DR-100-001",
      "itemName": "سبرايت ٣٥٠ مل",
      "unitName": "طرد", "unitCode": "طرد", "unitBaseQty": 30,
      "unitPrice": "10.000",             // price per the sale's chosen unit
      "taxPercentage": "16",
      "discountPercentage": "0",
      "soldQtyBase": 60,                 // base pieces
      "returnedQtyBase": 30,
      "remainingQtyBase": 30,
      "remainingQtyInUnit": 1            // remainingQtyBase / unitBaseQty (convenience)
    }
  ]
}
```

Notes / decisions:
- **Aggregate by `itemNumber`** (an item may appear on several sale lines or be returned under a different unit). All math in base pieces; expose `remainingQtyInUnit` for display.
- **Which returns count:** posted RETURN vouchers referencing the sale. **Open question:** also count approval-pending returns (return requests not yet posted)? If returns can sit in approval, a second request could double-count. Recommended v1: also subtract qty from **pending `approval_requests` of type `RETURN_VOUCHER`** whose payload `referenceVoucherNumber` = this sale, to prevent over-return while one is awaiting approval. Flag for confirmation.
- **No mutation** of the sale or any prior return — pure read + aggregate.
- Lines with `remainingQtyBase = 0` are still returned (shown disabled) so the salesman sees the full picture; or filter them out — **decision point** (recommend: include, greyed).

**Customer sales list** — already supported: `GET /vouchers?transKind=SALE&customerNumber=X` (`ListVouchersQueryDto`). Optionally add `isPosted=true` + date filter; ensure ordering newest-first.

### App changes
- **Source list:** the return flow lists customer sales via `customerSales(customerNumber)` only (drop the local-invoice picker + manual lookup as the primary path; keep lookup-by-number as a fallback that also calls the returnable endpoint). Always fetched from server.
- **On sale select:** call `GET /vouchers/:id/returnable`. Pre-fill the return cart from `lines`, each capped at `remainingQtyInUnit` (or base). Replace the VM's local `soldQtyByProduct` cap with the server `remainingQtyBase`.
  - `capReturnQty` uses `remainingQtyBase / unitConversionQty` for the selected unit.
  - Show per line: "returnable N <unit>" and disable lines with 0 remaining.
- **Unit handling:** the return line keeps `unitName`/`unitBaseQty` from the response so the exported return carries the unit (consistent with the unit work already shipped).
- **Pricing:** use the sale line's `unitPrice` + `taxPercentage` + `taxCalcMethod` so the credit matches the original sale.
- New app types: `ReturnableLineDto` + `ReturnableSaleDto`; `GetCustomerSalesUseCase` gains `returnable(saleIdOrNumber, customerNumber)`; `VoucherApi.returnable(...)`.

### Edge cases & rules
- Second return after a partial one → remaining reflects the first (verified by summing prior returns).
- Mixed units (sold طرد, returning حبة) → base-piece math nets correctly; cap in the chosen unit = `floor(remainingBase / unitBaseQty)` (or allow fractional base if the unit is the base).
- Over-return blocked client-side (cap) **and** server-side (the return create should reject if it would push returned > sold for any item — add a guard in `VouchersService.create` for RETURN with `referenceVoucherNumber`). **Recommended** so a stale app can't over-return.
- Return with no `referenceVoucherNumber` (free return) — out of scope of this calc; still governed by the existing return permission gate.
- Customer with no sales → empty list with a clear message.

### Acceptance
- Return screen shows only the selected customer's sales, fetched live.
- Selecting a sale shows each line's server-computed remaining qty; returning part, then reopening, shows the reduced remaining.
- The sale voucher row is never modified by any return.
- Exported return carries the correct unit + price and cannot exceed remaining (client + server enforced).

---

## File-change checklist (for implementation, after approval)

### Backend (cash-van)
- `vouchers.controller.ts` — add `GET /vouchers/:id/returnable` (+ by-number variant).
- `vouchers.service.ts` — `returnable()` aggregation; RETURN over-return guard in `create()`.
- `products.service.ts` `attachUnits()` — unit-price fallback (`priceFils = round(item.price × conversionQty)` when salePrice ≤ 0).
- (No change for logo/company-info/permissions — already served.)

### App (FlowVan)
- `core/network` — `CompanyInfoDto` add `sellerCityCode`; new `ReturnableSaleDto`/`ReturnableLineDto`; `VoucherApi.returnable(...)`.
- `core/datastore` / `AppSettings` (+Room bump) — persist `logoUrl`.
- `core/domain` — `RefreshCatalogUseCase` store `logoUrl`; `GetCustomerSalesUseCase.returnable(...)`.
- `feature/home/SettingsScreen.kt` + `SettingsViewModel.kt` — split into editable Connection vs read-only Company/policy (+ logo + permKeys + tax mode display).
- `feature/voucher` — `VoucherViewModel` return flow: server source list + `returnable` prefill + cap by `remainingQtyBase`; unit-price fallback; replace add-item hero avatar with `AsyncImage`; ensure all item lists use `ProductThumb`.

### Open questions to confirm before build
1. Theme/language — keep editable (Display section) or make everything except IP read-only?
2. Returnable calc — also subtract **pending approval** return requests (prevent over-return while awaiting approval)?
3. Zero-remaining lines — show greyed or hide?
4. Server-side over-return guard on RETURN create — include now (recommended) or app-cap only?
