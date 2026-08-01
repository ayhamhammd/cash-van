# Prospecting / Lead Finder — Work Plan
**Feature:** find potential customers (supermarkets, malls, groceries) around a map point,
filter out existing customers, generate a branded price-quote PDF, and reach out via WhatsApp.
**Target surface:** VanFlow Office Dashboard (+ backend). Mobile (FlowVan) is a later phase.

---

## 1. How it works (end-to-end flow)

```
[Quote Template setup]                    [Prospecting session]
 logo + company description                pick map point + radius + categories
 products + editable prices                     │
 contact phones + WhatsApp message         Google Places Nearby Search (server-side)
      │                                         │
 saved template ──► PDF (print CSS)        candidates (name, location, phone, rating)
      │                                         │
 public tokenized PDF link              de-dup vs existing customers
      │                                  (phone match / coordinate distance / name)
      └──────────────┬──────────────────────────┘
                     ▼
        Prospect list (NEW / QUOTED / CONTACTED / CONVERTED / REJECTED)
                     │
        wa.me click-to-chat: prefilled message + PDF link → rep hits Send
                     │
        link-open tracking → "convert to customer" (one click, prefilled form)
```

## 2. Data model (backend, new tables)

| Table | Purpose | Key columns |
|---|---|---|
| `prospect_searches` | One search session | `id, center_lat, center_lng, radius_m, categories jsonb, created_by, created_at` |
| `prospects` | One candidate business | `id, search_id, google_place_id (unique), name, lat, lng, address, phone, category, rating, status, matched_customer_id → customers, sent_at, link_opened_at, notes, created_at` |
| `quote_templates` | Reusable quote definition | `id, name, logo_url, description_ar, phones jsonb, items jsonb [{itemNumber, nameAr, priceFils}], whatsapp_message_ar, public_token (for the PDF link), created_at, updated_at` |

Notes:
- `google_place_id` may be stored indefinitely per Google's ToS; other Places fields have
  caching limits (~30 days) — we keep them as **our CRM lead data** once the user saves a
  prospect, and re-fetch details on demand when stale.
- `status` enum: `NEW → QUOTED → CONTACTED → CONVERTED | REJECTED`. `matched_customer_id`
  set ⇒ shown as "already a customer" and excluded from outreach by default.

## 3. De-duplication rules (in order)

1. **Phone**: normalize (strip +962/0, spaces, dashes) and compare against `customers.phone`.
2. **Distance**: haversine < **75 m** from an existing customer with coordinates → likely same shop.
3. **Name similarity** (trigram/`ILIKE` on normalized Arabic name) → flagged "possible match"
   for manual review rather than auto-excluded.

## 4. Backend endpoints (NestJS, `/api/v1`)

| Endpoint | What it does |
|---|---|
| `POST /prospecting/searches` | Body: center, radius, categories. Calls Places **server-side** (key never reaches the browser), runs de-dup, persists prospects, returns them |
| `GET /prospecting/searches` / `GET .../:id/prospects` | History + results |
| `PATCH /prospecting/prospects/:id` | status, notes |
| `POST /prospecting/prospects/:id/convert` | Creates a customer from the prospect (name, phone, coords), links it back |
| `GET/POST/PATCH /quote-templates` | CRUD |
| `GET /q/:token` | **Public** (no JWT): serves the quote PDF/HTML page; increments `link_opened_at` on the prospect via `?p=<prospectId>` — this is the outreach tracking |

Places calls: `places:searchNearby` with `includedTypes` mapped from the user's category
picks (`supermarket`, `grocery_store`, `shopping_mall`, `convenience_store`, `market`), field
mask limited to id/name/location/types/rating; **one `place details` call per candidate** to get
the phone number (contact fields aren't in Nearby results). Cache by `google_place_id`.

## 5. Quote PDF — zero-infrastructure approach

The dashboard already prints vouchers via print-styled pages. The quote reuses that:
- A print-styled RTL page (Tajawal font) renders: logo → company description → product table
  (name / price, from the template) → offers note → contact phones.
- "تحميل PDF" = browser print-to-PDF. No Puppeteer, no server-side renderer, no new containers.
- The same page served at `GET /q/:token` doubles as the **link sent on WhatsApp** — recipients
  open a mobile-friendly quote page (better than a PDF attachment on phones), and the open is
  tracked. A "Save as PDF" button sits on that page for recipients who want the file.

## 6. WhatsApp outreach (see COSTS section for why this design)

- Per prospect: **"إرسال عرض السعر"** button → opens `https://wa.me/<phone>?text=<message + quote link>`
  in a new tab → WhatsApp Web/Desktop opens the chat prefilled → the user presses Send.
- One click per prospect, sent from the company's own WhatsApp number — replies land in a real
  chat a human can continue.
- On click, the prospect auto-moves to `CONTACTED` with `sent_at` stamped.
- **No bulk auto-send.** This is deliberate (policy + ban risk — see COSTS).

## 7. Frontend (dashboard) — new feature module `src/features/prospecting/`

| View | Contents |
|---|---|
| **العملاء المحتملون** page (nav entry) | Split view: Google Map (point picker + radius circle + category chips + "ابحث") · results table (DataTable) with status badges, distance, phone, actions |
| Quote template builder | Drawer/modal: logo, description, phones, WhatsApp message, product picker (searchable, editable prices) · live preview |
| Prospect drawer | Details, map mini-view, notes, status timeline, WhatsApp button, "تحويل إلى زبون" |

Standard rules apply: RBAC-gated (admin/office), all strings in `dictionaries.ts` (ar+en),
RTL-first, `DataTable` for the list, TanStack Query hooks in `api.ts`.

## 8. Phases & estimates

| Phase | Scope | Est. |
|---|---|---|
| **P1** | Quote template CRUD + print-styled quote page + public tokenized link | 2–3 days |
| **P2** | Places search (server-side) + de-dup + prospects table + map picker UI | 3–4 days |
| **P3** | WhatsApp click-to-chat + status flow + link-open tracking + convert-to-customer | 1–2 days |
| **P4** (later) | Analytics (conversion per area), FlowVan mobile surfacing ("prospects near me" for reps), auto re-search of stale areas | — |

Total to a usable v1: **~6–9 working days**.

## 9. Risks & honest caveats

- **WhatsApp policy**: any *automated bulk* messaging to numbers that never opted in violates
  Meta's Business/Commerce policy on **both** the official API and unofficial libraries. Unofficial
  automation (whatsapp-web.js / Baileys) additionally violates WhatsApp ToS and regularly gets
  numbers **banned** — losing the company's WhatsApp number. The click-to-chat design keeps a
  human on the Send button: free, compliant in practice, and the volume (tens of prospects per
  area) genuinely doesn't need bulk automation.
- **Places data quality in Jordan**: small groceries are often missing or have no phone number
  on Google. Expect some prospects with `phone = null` → the UI shows them with a "no phone"
  badge (still useful for a physical visit by the rep).
- **Google ToS on caching**: place data other than `place_id` shouldn't be stored beyond ~30
  days as *Google data*; once the user saves/edits a prospect it becomes their CRM record.
  Practical risk is low; noting it for completeness.
- **Quote page is public** (tokenized URL). Prices on it are the prices you chose to send —
  don't put contract-customer prices in a template meant for cold outreach.

---

# COSTS — the "free" question, honestly

## Google (search + map)

Pricing model (2026): pay-as-you-go per SKU with **monthly free call allowances** —
Essentials 10,000 / Pro 5,000 / Enterprise 1,000 free calls per month, resetting monthly
(the old $200 credit is gone).

| Need | SKU | Free/month | Our usage |
|---|---|---|---|
| Map picker on the page | Maps JS (dynamic map) | 10,000 loads | Already used by the dashboard today — same key |
| Find businesses in radius | Nearby Search (Pro) | 5,000 calls | 1 call per search session |
| Phone numbers | Place Details w/ contact fields | 5,000 calls | ~1 per candidate (20–60 per search) |

A heavy month — say 40 searches × 60 candidates — is ~2,440 Details calls + 40 searches:
**comfortably inside the free tier → $0**. Field masking (request only what we need) keeps
each call in the cheapest bucket. The key lives server-side with a quota alarm set in Google
Cloud Console so it can never silently start billing.

Free alternative considered: **OpenStreetMap/Overpass** — genuinely free, but coverage of small
Jordanian shops (and especially phone numbers) is far weaker than Google's. Not worth the data
quality loss given Google lands at $0 for this volume anyway.

## WhatsApp

| Option | Cost | Verdict |
|---|---|---|
| **Click-to-chat (`wa.me`) + human send** | **$0** | ✅ **Recommended.** No API, no ban risk, replies arrive on the company's real number |
| Official Cloud API (Meta) | No subscription, but **per delivered marketing template ~$0.01–$0.14 by country**, template pre-approval, and marketing to non-opted-in users is restricted; per-message billing expands Oct 2026 | ❌ Costs money *and* cold outreach conflicts with policy |
| Unofficial libraries (whatsapp-web.js / Baileys) | $0 | ❌ ToS violation, frequent number bans — losing the business number costs more than any API fee |

**Bottom line:** the recommended architecture runs at **$0/month** for both services at your
realistic volume, with the only "cost" being one human click per prospect on Send — which is
also what keeps it safe.

Sources: [Google Maps Platform pricing](https://mapsplatform.google.com/pricing/) ·
[Places API free-tier limits 2026](https://www.mapsleads.co/blog/google-places-api-free-tier-limits-2026) ·
[Places pricing guide](https://www.safegraph.com/guides/google-places-api-pricing/) ·
[WhatsApp Business API pricing 2026](https://sleekflow.io/en-us/blog/whatsapp-business-price) ·
[WhatsApp per-message rates](https://setsmart.io/blog/whatsapp-business-api-pricing) ·
[2026 billing changes](https://blueticks.co/blog/whatsapp-business-api-pricing-2026)
