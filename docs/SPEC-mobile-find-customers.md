# SPEC — "Find customers" on the salesman app

> **Status (2026-08-21): shipped.** Backend, dashboard toggle, and the mobile
> screen are all in. One change from this spec: `canFindCustomers` turned out to
> be a *real* boundary, not visibility-only — the search endpoint now accepts
> `canManageOffers` OR `canFindCustomers`, so a rep without either is refused
> 403 (verified live). The dashboard **new-customers report screen** (§6.2) is
> the one piece not yet built; the report API behind it is.

The prospecting feature the dashboard already has, put in the rep's hand: open a screen from
the home page, it reads GPS, searches **2 km** around them, lists the shops it finds, and
lets the rep navigate to one or file it as a customer with the name, phone and location
already filled in.

Reuses the existing `/api/v1/prospecting/*` API unchanged. New work is a mobile screen, one
permission, customer provenance, and a dashboard report.

---

## 1. What exists today (verified 2026-08-20)

- **`POST /prospecting/searches`** — `{ lat, lng, radiusM, categories?, keywords? }`.
  `radiusM` is validated 200–20,000, so 2 km needs no change. Returns the search plus its
  prospects; re-searching an area updates leads by `google_place_id` rather than duplicating.
- **`GET /prospecting/prospects?searchId=…`** — already filterable by search, which is
  exactly what the handset needs to read back its own run.
- **`GET /prospecting/categories`** — the allow-list plus a `featured` subset meant to be
  rendered as one-tap chips. Free-text `keywords` (max 5) is the "add your own" path.
- **`ProspectsController` carries no `@Roles` guard**, so any authenticated user — including
  a SALES account — can already call it. No backend permission work is needed to *reach* it.
- **Mobile already has every part** this screen needs: `LocationProvider` (common/Android/iOS),
  `MapNavigationScreen`, `CreateCustomerScreen`.
- **A photo is mandatory** for a salesman-created customer: the backend returns
  400 "A customer document photo is required", and `CreateCustomerState.canSave` enforces it
  client-side so the rep is not sent on a failing round trip.
- **`convert()` records no provenance on the customer.** The link is one-way —
  `prospect.matched_customer_id → customer.id` — so nothing on a customer says it came from a
  search. §5 fixes that.

## 2. Decisions

| question | decision |
|---|---|
| Radius | **Fixed 2 km.** No control on the screen. |
| Photo | **Rep must photograph the shop.** The existing rule is unchanged: a prospect prefills name/phone/location, and the rep still has to be there to file it. |
| Approval | **Unchanged `canCreateCustomerDirect` gate** — direct create with the permission, approval request without it. |
| Visibility | **New `canFindCustomers` permission.** The home tile and the whole screen appear only when it is on. |

The photo decision is the one that keeps this honest. The search finds shops on a map; the
photo is what proves a human went to one. Prefilling the form is a convenience, not a
shortcut past that.

---

## 3. Permission — `canFindCustomers`

New per-user flag, same shape as `canRequestStock` / `canApproveStockRequest`.

- Migration: `ALTER TABLE users ADD COLUMN can_find_customers boolean NOT NULL DEFAULT false`.
- `User` entity, the `/auth/login` + `/auth/me` permissions payload, and the dashboard's
  `Permissions` type and user editor.
- **Defaults FALSE**, like every other capability: nobody gains a feature on upgrade until the
  office grants it.
- Mobile hides the home tile and refuses the route when it is off. Server-side this is a
  visibility flag only — the prospecting endpoints stay open to any authenticated user, so
  do **not** treat it as a security boundary. If it must be one, add a guard to
  `ProspectsController` in the same change.

## 4. Mobile

New module `feature/prospecting` (or folded into `feature/customer`), matching the existing
Contract / ViewModel / Screen split.

### 4.1 Find-customers screen

1. On entry, request location and call `LocationProvider`. No GPS ⇒ explain and offer retry;
   never search from a stale or default point.
2. `POST /prospecting/searches` with `{ lat, lng, radiusM: 2000, categories, keywords }`.
3. Category chips from `GET /prospecting/categories` (`featured` first), multi-select, plus a
   **free-text field** that appends to `keywords` — the "add a new option" from the web.
4. Results list, nearest first. Each row: **name**, category, distance from the rep, address,
   phone when Google has one, and a badge when the prospect is already a customer
   (`matchedCustomerId` set) so nobody re-adds a shop the company already sells to.
5. Two actions per row:
   - **Location** → the map screen (§4.2)
   - **Add customer** → the create screen, prefilled (§4.3)

Distance is computed client-side from the search centre; the API does not return it.

### 4.2 Map — a prospect is not a customer

`MapNavigationScreen(customerId)` loads a `Customer` by id. A prospect has no customer row, so
it cannot be reused as-is. Add a route that takes a raw point:

    Routes.MAP_POINT = "map/point?lat={lat}&lng={lng}&label={label}"

and have `MapNavigationViewModel` accept either a `customerId` **or** a `LatLng + label`. Same
screen, same navigation, one extra source of truth for the destination.

### 4.3 Add customer, prefilled

`Routes.CREATE_CUSTOMER` currently takes no arguments. Add optional ones:

    Routes.createCustomer(name?, phone?, lat?, lng?, prospectId?)

`CreateCustomerState` seeds `name`, `phone`, `lat`, `lng` from them; `prospectId` is held and
sent on save. Everything else is unchanged — **the photo is still required and the approval
gate still applies**. The rep may edit any prefilled field before saving.

On success the app should also mark the prospect converted so it stops appearing as a lead.

## 5. Provenance — how a customer remembers it came from a search

Two columns on `customers`:

    source              text  NOT NULL DEFAULT 'MANUAL'   -- 'MANUAL' | 'PROSPECTING' | 'IMPORT' | 'ERP'
    source_prospect_id  uuid  NULL                        -- the lead it came from

- `CreateCustomerDto` gains an optional `sourceProspectId`. When present the service sets
  `source = 'PROSPECTING'`, links the prospect, and stamps it `CONVERTED`.
- `ProspectsService.convert()` sets the same two fields, so a customer created from the
  dashboard and one created from the handset are indistinguishable afterwards.
- Existing rows default to `MANUAL`, which is the truthful answer for anything created before
  this shipped.

A reverse lookup (`prospects WHERE matched_customer_id = …`) would avoid the columns, but it
costs a join per row on every customer list and cannot be indexed usefully for a report. The
column is the right call here.

## 6. Dashboard

### 6.1 Badge on the customer

Wherever a customer is listed or opened, show a small marker when `source = 'PROSPECTING'`,
with the search date on hover. Cheap, and it answers "where did this customer come from?"
directly instead of by inference.

### 6.2 New-customers report

    GET /api/v1/reports/new-customers?from=&to=&source=&repId=

Returns counts and rows of customers created in the window, grouped by `source` and by rep.
The screen shows:

- **Total new customers**, and **how many came from Find Customers** — the number that says
  whether the feature is earning its Places bill.
- A per-rep breakdown, so the office can see who is prospecting and who is not.
- The list itself, each row linking to the customer.

Both `customers.source` and `customers.created_at` want an index for this.

## 7. Order of work

1. **Backend** — `canFindCustomers`, the two `customers` columns, `sourceProspectId` on the
   create DTO, `convert()` parity. Independently shippable and invisible until used.
2. **Mobile** — module, screen, the two route changes, home tile behind the permission.
3. **Dashboard** — permission toggle in the user editor, customer badge, report.

The dashboard toggle should land with or before the mobile build, or there is no way to turn
the feature on for anyone.

## 8. Out of scope

- Rep-scoped prospect visibility. `GET /prospecting/prospects` returns everything; the handset
  filters by its own `searchId`. If reps should not see each other's leads, that is a separate
  change to the controller.
- WhatsApp outreach and quote links, which stay a dashboard concern.
- Offline search. The screen requires connectivity; there is no cached-results mode.
