# Offers Engine — Dashboard Spec (cash-van-dashboard-frontend)

> Status: **DRAFT / design** · Layer: web control plane (admin/manager) · Backend contract: `cash-van-dashboard/docs/OFFERS.md`
> Follows the project conventions in `.claude/CLAUDE.md` (TanStack Query hooks, RTL-first, RBAC-gated writes, no `any`).

The dashboard is where managers **create, schedule, target, preview, and report** on offers. It
does not compute discounts — the backend is authoritative; the dashboard only edits definitions
and previews via `/offers/evaluate`.

---

## 1. Offer types (manager vocabulary)

The create/edit form is a **type-first wizard**: pick a type, then fill only that type's fields.

| Type | Card title (en / ar) | What the manager sets |
|------|----------------------|------------------------|
| `ITEM_QTY_DISCOUNT` | Item quantity discount / خصم على كمية صنف | item, min qty, discount (% or value) |
| `BUY_X_GET_Y_FREE` | Buy & get free / اشترِ واحصل على هدية | trigger item + qty, free item + qty |
| `BASKET_THRESHOLD` | Basket reward / مكافأة السلة | item set, min item count, reward = invoice discount **or** free-item list |
| `ITEM_SET_THRESHOLD` | Selected-items threshold / عتبة أصناف محددة | items X/Y/Z, min total qty, match ANY/ALL, reward = discount / free item / set discount |
| `LOYALTY_FIRST_PURCHASE` | New-customer / عميل جديد | reward = invoice discount **or** free item |

> **Free item rule (show everywhere):** a free item appears on the invoice as its own line at its
> real price with a **100% discount**. Surface a hint in the form so managers understand pricing/tax.

---

## 2. Feature layout

Route: `/offers` (new nav entry under "Operations"; add to `nav.ts` + `icons.ts` + i18n keys).

```
src/features/offers/
  api.ts            # DTOs + TanStack Query hooks
  OffersView.tsx    # list + stats + filters
  OfferFormModal.tsx# type-first create/edit wizard
  OfferPreview.tsx  # live cart preview via /offers/evaluate
  OfferRedemptions.tsx # per-offer usage report
  offerTypes.ts     # type metadata, labels, default config, validators
src/app/(dashboard)/offers/page.tsx  # thin server component
```

---

## 3. List view (`OffersView`)

- `PageHeader` + "New offer" (`<Can perm="offers.manage">`).
- `StatCard`s: Active, Scheduled (future `validFrom`), Expired, Redemptions this month.
- Filter chips: All / Active / Paused / Expired + a type dropdown + search.
- `DataTable<Offer>` columns: Name · Type (badge) · Reward summary · Eligibility · Window (from–to) · Status (Active/Paused/Scheduled/Expired) · Redemptions · actions (Edit, Toggle, Report, Delete).
- Reward summary renders human text, e.g. *"6× ICETEA-330 → 1 WATER-500 free"*, *"10% off invoice"*.

---

## 4. Create / edit wizard (`OfferFormModal`)

**Step 1 — Type:** a grid of the 5 type cards (icon + one-line description). Selecting one sets defaults.

**Step 2 — Trigger** (type-specific):
- `ITEM_QTY_DISCOUNT`, `BUY_X_GET_Y_FREE`: item picker (reuse the customer/product picker pattern) + min qty.
- `BASKET_THRESHOLD`: multi-item set picker + min item count.
- `ITEM_SET_THRESHOLD`: multi-item set picker + min total qty + ANY/ALL toggle.
- `LOYALTY_FIRST_PURCHASE`: no trigger fields (auto: new customer's first purchase).

**Step 3 — Reward** (constrained to the type's allowed rewards):
- Discount: type (PERCENT/VALUE) + value + `appliesTo` (trigger item / set / invoice — only valid options shown).
- Free item: fixed item(s) + qty, **or** a choice list (`FREE_ITEM_CHOICE`) the rep picks from at sale.

**Step 4 — Eligibility & schedule:**
- Customer scope: All / Segment / Specific customers / New only.
- Optional store / region / rep scoping.
- `validFrom`–`validTo`, days-of-week chips, time-of-day window.
- Limits: total redemptions, per-customer.
- `priority`, `stackable` toggle.

**Step 5 — Review & preview:** human-readable summary + `OfferPreview` (build a sample cart, call `/offers/evaluate`, show resulting discounts/free lines).

Validation lives in `offerTypes.ts` so the form can't submit a reward illegal for the chosen type.

---

## 5. API hooks (`api.ts`)

```ts
useOffers(params)            // GET /offers
useOffer(id)                 // GET /offers/:id
useCreateOffer()             // POST /offers
useUpdateOffer()             // PATCH /offers/:id
useToggleOffer()             // POST /offers/:id/toggle
useDeleteOffer()             // DELETE /offers/:id
useOfferRedemptions(id)      // GET /offers/:id/redemptions
useEvaluateOffers()          // POST /offers/evaluate  (preview)
```
- Add `endpoints.offers` to `src/lib/api/endpoints.ts`.
- Type `Offer`, `OfferTrigger`, `OfferReward`, `OfferEvaluation` explicitly (no `any`); mirror the BE config shapes.
- Mutations invalidate `["offers"]`.

---

## 6. Preview (`OfferPreview`)

A mini cart builder (add items + qty + customer) → debounced `useEvaluateOffers` → render:
- per-line discounts, appended free lines (badge "FREE — 100% off"), invoice discount, and the
  `appliedOffers` list. Mirrors exactly what the mobile/sale will produce.

---

## 7. Operations / reporting integration

- The Operations voucher view already shows `customerName`; add an **"Offers"** badge/column when a voucher has `applied_offer_ids`, linking to the offer.
- `OfferRedemptions`: table of redemptions (voucher #, customer, discount granted, free items, date) + totals; export to XLS using the existing `exportTableXls`.

---

## 8. RBAC, i18n, RTL

- New permission `offers.manage` gates all write UI (`<Can>`); read may be admin/manager only.
- Every label in `dictionaries.ts` (ar + en). Numbers/IDs render mono + LTR; use logical `start/end`.
- Money formatting via existing `formatJOD`/`formatJODMajor` — **mind the mixed-units rule** (vouchers/reports = JOD major).

## 9. Acceptance (UI)

- Each type's wizard shows only its fields and only valid rewards.
- Preview matches backend evaluation for the 5 types.
- Toggling/scheduling reflects correct status badges.
- Free-item lines render with the 100%-off badge in preview and in the voucher view.
