# SPEC — Prospecting / Lead Finder (العملاء المحتملون)

Implementation spec for the feature described in [PLAN.md](PLAN.md), UI per
[STITCH-BRIEF.md](STITCH-BRIEF.md). Backend = `cash-van-dashboard` (NestJS + TypeORM),
frontend = `cash-van-dashboard-frontend` (Next.js 15). No FlowVan/APK work in v1.

Phases ship independently: **P1 quote templates → P2 search & prospects → P3 outreach**.
Each phase ends green on its verify gate before the next starts.

---

## 0. Environment & config

Backend `.env` (new):

```
GOOGLE_PLACES_API_KEY=            # server-side only; NEVER sent to the browser
PROSPECTING_ENABLED=true          # kill-switch; endpoints 404 when false
PUBLIC_BASE_URL=http://77.245.5.113:3002   # used to build public /q/<token> links
```

Google Cloud: enable **Places API (New)** on the key; set a billing budget alarm.
The dashboard's existing browser Maps key is untouched and stays browser-side for the map UI.

---

## 1. Backend

### 1.1 New module: `src/modules/prospecting/`

```
prospecting/
  prospecting.module.ts
  prospecting.controller.ts        # authenticated endpoints
  public-quote.controller.ts       # public /q/:token (no JWT)
  prospecting.service.ts           # orchestration + dedup
  places.service.ts                # Google Places (New) client
  quote-templates.service.ts
  entities/
    prospect-search.entity.ts
    prospect.entity.ts
    quote-template.entity.ts
  dto/
    create-search.dto.ts
    update-prospect.dto.ts
    quote-template.dto.ts
  prospecting.types.ts
  prospecting.spec.ts              # dedup + phone normalization unit tests
```

### 1.2 Entities (all extend `BaseEntity`: uuid id, created/updated/deleted_at, version)

**`prospect_searches`**

| column | type | notes |
|---|---|---|
| `center_lat`, `center_lng` | `double precision` | |
| `radius_m` | `int` | 200–5000, validated |
| `categories` | `jsonb` | `string[]` of category keys (§1.5) |
| `result_count`, `new_count` | `int` | denormalized for the history list |
| `created_by` | `uuid` | FK → users, `ON DELETE SET NULL` |

**`prospects`** — `@Index unique` on `google_place_id`

| column | type | notes |
|---|---|---|
| `search_id` | `uuid` | FK → prospect_searches `ON DELETE CASCADE` |
| `google_place_id` | `text` | unique — re-searching an area upserts, never duplicates |
| `name` | `text` | |
| `lat`, `lng` | `double precision` | |
| `address` | `text` nullable | |
| `phone` | `text` nullable | raw from Google |
| `phone_normalized` | `text` nullable | digits only, no leading 962/0 (§1.6) |
| `category` | `text` | first matched category key |
| `rating` | `real` nullable | |
| `status` | `text` | `NEW / QUOTED / CONTACTED / CONVERTED / REJECTED`, default `NEW` |
| `matched_customer_id` | `uuid` nullable | FK → customers; set ⇒ "already a customer" |
| `match_reason` | `text` nullable | `PHONE / DISTANCE / NAME` (NAME = flagged, not excluded) |
| `quote_template_id` | `uuid` nullable | template used for outreach |
| `sent_at`, `link_opened_at` | `timestamptz` nullable | outreach tracking |
| `notes` | `text` nullable | |

**`quote_templates`**

| column | type | notes |
|---|---|---|
| `name` | `text` | |
| `logo_url` | `text` nullable | data-URI or `/storage` path, same as company-info logo |
| `description_ar` | `text` | |
| `phones` | `jsonb` | `string[]` |
| `items` | `jsonb` | `[{ itemNumber, nameAr, priceFils }]` — prices are per-template copies, NOT live catalog prices |
| `whatsapp_message_ar` | `text` | may contain `{link}` placeholder |
| `public_token` | `text` unique | 32-char url-safe random; regenerable |
| `is_active` | `boolean` default true | |

Migration: `src/database/migrations/<ts>-Prospecting.ts` — three `CREATE TABLE`s + indexes
(`idx_prospects_status`, `idx_prospects_search_id`, unique `uq_prospects_place_id`,
unique `uq_quote_templates_token`). Runs automatically via `start:deploy`.

### 1.3 Authenticated endpoints (`@Roles('admin')`, standard envelope)

| Method & path | Body / query | Returns |
|---|---|---|
| `POST /prospecting/searches` | `{ centerLat, centerLng, radiusM, categories[] }` | search row + `prospects[]` (deduped, sorted by distance) |
| `GET /prospecting/searches` | `offset,limit` | history |
| `GET /prospecting/prospects` | `offset,limit,q,status?,searchId?,isNew?` | table feed |
| `PATCH /prospecting/prospects/:id` | `{ status?, notes?, quoteTemplateId? }` | updated row |
| `POST /prospecting/prospects/:id/mark-sent` | `{ quoteTemplateId }` | sets `status=CONTACTED`, `sent_at=now()` — called when the user clicks the WhatsApp button |
| `POST /prospecting/prospects/:id/convert` | `{}` | creates a Customer (name→nameAr, phone, lat/lng; `customerNumber` = next free number per existing CustomersService logic), sets `status=CONVERTED`, links `matched_customer_id`; **409** if already converted |
| `GET/POST /quote-templates`, `GET/PATCH/DELETE /quote-templates/:id` | template DTO | CRUD; DELETE = soft |
| `POST /quote-templates/:id/regenerate-token` | | new `public_token` (invalidates old links) |

`POST /searches` flow: validate → 1 Places call **per selected category** (§1.5) → merge by
place_id → dedup (§1.6) → upsert prospects (`ON CONFLICT (google_place_id) DO UPDATE` name/
phone/rating only — never status/notes/sent_at) → return.

### 1.4 Public quote endpoint — `public-quote.controller.ts`

- `GET /q/:token?p=<prospectId>` — **`@Public()`**, rate-limited (reuse the global throttler,
  tighter bucket: 30/min/IP). Returns the rendered quote **HTML page** (server-rendered by
  Nest via a simple template string — no view engine needed): RTL, Tajawal via Google Fonts,
  logo, description, product/price table (JOD, 3 decimals from fils), phones as `tel:` links,
  print button (`window.print()`).
- Side effect: valid `p` + first visit ⇒ `link_opened_at = now()` (never overwritten).
- Unknown token ⇒ plain 404 page. Template inactive ⇒ 410.
- **No customer data is ever on this page** — token guessing exposes only the public price list.

### 1.5 `places.service.ts` — Google Places (New)

- `POST https://places.googleapis.com/v1/places:searchNearby`, headers `X-Goog-Api-Key`,
  `X-Goog-FieldMask: places.id,places.displayName,places.location,places.formattedAddress,places.types,places.rating,places.nationalPhoneNumber`.
- Body: `{ includedTypes: [<google types for ONE category>], maxResultCount: 20, locationRestriction: { circle: { center, radius } } }`.
  One call per category (API caps 20 results/call — this is also why multi-category = multi-call).
- Category map (key → Google `includedTypes`):
  `supermarket→[supermarket]`, `grocery→[grocery_store]`, `convenience→[convenience_store]`,
  `mall→[shopping_mall]`.
- Requesting `nationalPhoneNumber` puts the call in the **Enterprise SKU (1,000 free/mo)**;
  each call returns up to 20 places *with phones*, so ~250 multi-category searches/month stay
  free — far better than per-place Details calls. Document this in code.
- Errors: non-200 → `BadGatewayException('places_unavailable')`; missing key → 503 with a clear
  message. Log request count per day (simple counter in AppSettings or log line) so quota use
  is observable.

### 1.6 Dedup (`prospecting.service.ts`) — pure function, unit-tested

```
normalizePhone(raw): digits only → strip leading '00' → strip leading '962' → strip leading '0'
  "+962 79 123 4567" → "791234567";  "06-568-1234" → "65681234";  null/"" → null

match order per candidate (first hit wins):
  1. PHONE:    phone_normalized non-null AND equals any customer's normalized phone
  2. DISTANCE: haversine(candidate, customer-with-coords) < 75 m
  3. NAME:     normalized Arabic name (strip ال، spaces, diacritics) similarity ≥ 0.6 (pg_trgm
               or in-process Dice) → sets match_reason='NAME' but matched_customer_id stays
               NULL — UI shows "تطابق محتمل" for manual review
```

Customers loaded once per search (number, phone, lat/lng, nameAr) — ~600 rows, in-memory is fine.

### 1.7 Tests (`prospecting.spec.ts`)

- `normalizePhone`: the 6 shapes above + garbage input.
- Dedup: phone hit, distance hit at 74m vs 76m, name-only flag, no-match.
- Upsert: re-search preserves `status/sent_at/notes`.
- Convert: creates customer once; second call → 409.

---

## 2. Frontend

### 2.1 New feature module `src/features/prospecting/`

```
prospecting/
  api.ts               # DTOs + TanStack Query hooks (endpoints below)
  ProspectingView.tsx  # screen 1+2: map search + results/table (tab or split)
  ProspectDrawer.tsx   # detail drawer: info, notes, timeline, actions
  QuoteTemplatesView.tsx / QuoteTemplateModal.tsx   # screen 3: builder + live preview
  whatsapp.ts          # buildWaLink(prospect, template, publicBaseUrl)
```

`src/lib/api/endpoints.ts` — add:

```ts
prospecting: {
  searches: "/prospecting/searches",
  prospects: "/prospecting/prospects",
  prospect: (id: string) => `/prospecting/prospects/${id}`,
  markSent: (id: string) => `/prospecting/prospects/${id}/mark-sent`,
  convert: (id: string) => `/prospecting/prospects/${id}/convert`,
},
quoteTemplates: {
  list: "/quote-templates",
  one: (id: string) => `/quote-templates/${id}`,
  regenerateToken: (id: string) => `/quote-templates/${id}/regenerate-token`,
},
```

### 2.2 Screens (visuals per STITCH-BRIEF.md; primitives per design-system.md)

**Screen 1 — search**: split view. Map = existing Google Maps setup (`APIProvider`, dark style,
reuse the pattern from `features/livemap/GoogleMapCanvas.tsx`): click drops accent pin +
`radius` circle; floating card = radius slider (200–5000m, mono value), category chips
(multi), primary "ابحث" → `POST /searches` → results panel rows (name, category+distance,
mono phone or "بدون هاتف" badge, rating, status badge); existing customers dimmed under a
divider with "زبون حالي" badge; count summary + الكل/جديد toggle.

**Screen 2 — prospects table**: `DataTable` fed by `GET /prospects` (server pagination, `q`
search). Columns: الاسم، التصنيف، الهاتف (mono LTR), الحالة (Badge tones: NEW=accent,
QUOTED=amber, CONTACTED=teal, CONVERTED=green, REJECTED=red), أُرسل في, فتح العرض (dot),
إجراءات (WhatsApp icon-button + overflow: تحويل، ملاحظات، رفض). KPI strip: 4 `StatCard`s
(محتملون جدد / أُرسل لهم / فتحوا العرض / تحوّلوا). Row click → `ProspectDrawer`.

**Screen 3 — quote template builder**: modal/drawer, two columns. Form: name, logo upload,
description textarea, phones (repeatable), WhatsApp message textarea (hint: `{link}` يُستبدل
برابط العرض), product picker = **reuse the offers form's searchable `MultiSelect` pattern**
with an editable JOD price input per selected item (default = catalog price, stored in fils).
Preview column: light "paper" card mirroring the public quote page live. Footer: حفظ /
معاينة كاملة (opens `/q/<token>` in new tab).

### 2.3 WhatsApp link (`whatsapp.ts`)

```ts
buildWaLink(p, t, base):
  phoneIntl = "962" + p.phoneNormalized          // already stripped of 0/962
  link      = `${base}/q/${t.publicToken}?p=${p.id}`
  text      = t.whatsappMessageAr.includes("{link}")
                ? t.whatsappMessageAr.replace("{link}", link)
                : `${t.whatsappMessageAr}\n${link}`
  return `https://wa.me/${phoneIntl}?text=${encodeURIComponent(text)}`
```

Button flow: disabled+tooltip when `phone` is null → else `window.open(waLink)` **and**
`POST /mark-sent` (optimistic; invalidates prospects + KPI queries).

### 2.4 Nav, RBAC, i18n

- `nav.ts`: entry after العروض — `href:"/prospecting", labelKey:"view.prospecting", icon:"MapPin"`
  (+ `/quote-templates` as a tab within the page, not separate nav).
- Pages: `src/app/(dashboard)/prospecting/page.tsx` (thin server component → ProspectingView).
- RBAC: whole page behind admin (same gate as offers); mutations wrapped in `<Can>`.
- i18n — add ar+en for: `view.prospecting`, `prospecting.title/subtitle`,
  `prospecting.search/searchHint/radius/categories/found/existing/newOnly/all/noPhone/rating`,
  `prospecting.status.{NEW,QUOTED,CONTACTED,CONVERTED,REJECTED}`,
  `prospecting.kpi.{new,sent,opened,converted}`,
  `prospecting.actions.{sendQuote,convert,reject,notes}`,
  `prospecting.convert.confirm`, `prospecting.possibleMatch`,
  `qt.{title,name,logo,description,phones,message,messageHint,items,price,save,preview,regenToken}`,
  `prospecting.cat.{supermarket,grocery,convenience,mall}`.
  Numbers/phones always `.text-mono`.

---

## 3. Acceptance criteria

**P1 (templates + public quote)**
- [ ] Create/edit/soft-delete a template; product prices editable per template, stored in fils
- [ ] `/q/<token>` renders RTL Arabic page: logo, description, table, tel: links; prints cleanly
- [ ] `?p=` stamps `link_opened_at` once; bad token → 404; inactive → 410; rate-limited
- [ ] Regenerate token invalidates the old link

**P2 (search + dedup)**
- [ ] Map click + radius + ≥1 category → results in <5s for 3 categories
- [ ] Existing customer with matching phone is auto-marked `زبون حالي` and excluded from "جديد فقط"
- [ ] Customer 75m-rule verified against a known real pair; name-similarity shows "تطابق محتمل" without excluding
- [ ] Re-running a search on the same area duplicates nothing and keeps statuses/notes
- [ ] Places key absent → clear error toast, no crash; browser never receives the key

**P3 (outreach + convert)**
- [ ] WhatsApp button opens wa.me with message+link, marks CONTACTED+sent_at
- [ ] No-phone prospects: button disabled with tooltip
- [ ] Convert creates a customer visible in the customers list, prospect → CONVERTED; repeat → 409
- [ ] KPI tiles reflect status changes without reload

**Gates (every phase)**: backend `npx jest src/modules/prospecting` + `tsc --noEmit`;
frontend `npm run typecheck && npm run lint && npm run build && npm test`.

## 4. Rollout

1. Migration runs automatically on deploy (`start:deploy`).
2. Add `GOOGLE_PLACES_API_KEY` + `PUBLIC_BASE_URL` to the client's `.env`; leave
   `PROSPECTING_ENABLED=false` until smoke-tested on the client server, then flip.
3. Ship via the existing `scripts/build-windows-bundle.sh` flow (both images rebuild).
4. No FlowVan/APK dependency — dashboard-only.

## 5. Explicitly out of scope (v1)

Bulk/automated WhatsApp sending (policy + ban risk — see PLAN.md) · server-side PDF rendering ·
FlowVan mobile surfacing · OSM fallback · multi-tenant quote pages · email outreach.
