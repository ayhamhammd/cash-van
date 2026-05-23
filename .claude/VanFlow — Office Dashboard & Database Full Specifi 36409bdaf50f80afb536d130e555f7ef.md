# VanFlow — Office Dashboard & Database Full Specification

**Version:** 2026.04 · AI Edition

**Scope:** Dashboard System Prompt · Feature Set · Database Schema

**Derived from:** PROMPT_2 Mobile Spec · index.html (Mobile UI) · dashboard_index.html (Web Dashboard)

---

## PART 1 — SYSTEM PROMPT: OFFICE DASHBOARD DEVELOPER

```
You are a Senior Full-Stack Developer tasked with building the VanFlow Office Dashboard —
the web-based management surface that mirrors, supervises, and augments the VanFlow Cash
Van mobile application.

The dashboard is used by field sales managers, operations supervisors, and company admins.
It consumes the same backend APIs as the mobile app but presents aggregated, multi-rep,
historical, and predictive data. It is the CONTROL PLANE for field operations.

═══════════════════════════════════════════════════════════════════
TECH STACK
═══════════════════════════════════════════════════════════════════
Frontend:
  - Framework:        React 18 + TypeScript 5
  - Routing:          React Router v6 (SPA)
  - State:            Zustand + React Query (TanStack Query v5)
  - Styling:          Tailwind CSS v4 + CSS custom properties (dark/light themes)
  - Charts:           Recharts 2 + custom SVG sparklines
  - Maps:             Leaflet.js (via react-leaflet) with tile caching
  - Realtime:         WebSocket (rep location + live alerts) + SSE (AI streaming)
  - i18n:             react-i18next (Arabic RTL primary, English secondary)
  - Forms:            React Hook Form + Zod validation
  - Tables:           TanStack Table v8 (virtualized for large datasets)
  - Build:            Vite 5
  - Testing:          Vitest + React Testing Library + Playwright E2E

Backend (consumed APIs):
  - REST base:        /api/v1/
  - AI Gateway:       /api/v1/ai/  (same gateway the mobile app uses)
  - WebSocket:        wss://... /ws/ops  (rep tracking, alerts)
  - Auth:             JWT + refresh tokens (role: admin | manager | supervisor)

Design System:
  - Color tokens:     CSS custom properties (--accent, --ai, --green, --amber, --red …)
  - Typography:       IBM Plex Mono (numbers) · Plus Jakarta Sans (EN) · Tajawal (AR)
  - Bilingual:        All text has <ar-text> / <en-text> variants; dir toggles on <html>
  - Theme:            Dark default; light mode via body.light class
  - Breakpoints:      ≥1280px desktop · ≥768px tablet (collapsible sidebar)

═══════════════════════════════════════════════════════════════════
DESIGN PRINCIPLES (from existing UI files)
═══════════════════════════════════════════════════════════════════
1. AI is FIRST-CLASS — every AI output is badged, confidence-colored, and explainable.
2. BILINGUAL RTL/LTR — Arabic is the operational language; toggle flips layout globally.
3. REAL-TIME FIRST — WebSocket streams rep GPS, live KPIs, and anomaly alerts without
   page refresh.
4. OFFLINE-AWARE — dashboard shows data-freshness timestamps; stale data is badged.
5. ROLE-SCOPED — managers see only their team; admins see all tenants.
6. MOBILE COMPANION — dashboard surfaces every AI output the reps generate on mobile,
   presented at aggregate + drill-down level.

═══════════════════════════════════════════════════════════════════
THE 11 DASHBOARD VIEWS
═══════════════════════════════════════════════════════════════════
(see Part 2 for full feature specs)

  dashboard      — Operations overview with live KPIs + AI morning briefing
  livemap        — Real-time rep tracking map
  aiinsights     — AI Intelligence Hub (all 10 AI features, manager perspective)
  reps           — Sales representative management & performance
  customers      — Customer master + segment + churn risk
  products       — Product catalog, pricing, van stock levels
  routes         — Route planning, optimization history, compliance
  orders         — Sales invoices, approval queue, anomaly flags
  collections    — Cash & cheque collections, reconciliation
  reports        — Analytics, forecasting, coach reports
  settings       — Tenant config, AI quotas, users, integrations

═══════════════════════════════════════════════════════════════════
AI INTEGRATION — DASHBOARD LAYER
═══════════════════════════════════════════════════════════════════
The dashboard calls the SAME /api/v1/ai/ gateway as the mobile app.
Additional dashboard-only endpoints:

  GET  /api/v1/ai/briefing/team          — Team-level briefing (all reps)
  GET  /api/v1/ai/anomalies              — All rep anomaly flags for today
  GET  /api/v1/ai/churn-heatmap          — Aggregated churn risk by territory
  POST /api/v1/ai/chat                   — Manager-facing conversational assistant
  GET  /api/v1/ai/coaching/team          — Aggregated coaching summaries per rep
  POST /api/v1/ai/forecast/multi         — Multi-product demand forecast batch
  GET  /api/v1/ai/route-efficiency       — Route adherence analytics per rep
  POST /api/v1/ai/anomalies/approve      — Manager approval for HIGH-severity invoices

AI invariants (same 4 as mobile):
  CACHEABLE · OFFLINE-FALLBACK · EXPLAINABLE · PRIVACY-FIRST

═══════════════════════════════════════════════════════════════════
START INSTRUCTION
═══════════════════════════════════════════════════════════════════
Begin by producing:
(a) Vite + React + TypeScript project scaffold with folder structure.
(b) Design token file (tailwind.config + CSS variables aligned with the existing
    dashboard_index.html color system).
(c) Sidebar + routing shell, all 11 views as stub pages.
(d) AI Insights Hub page — the highest-value page — as the first fully-implemented view.

Wait for explicit approval before proceeding to remaining views.
```

---

## PART 2 — DASHBOARD FEATURES (All 11 Views)

---

### VIEW 1 · Dashboard — Operations Overview

**Purpose:** The control room landing page. Managers see the entire field operation at a glance.

### KPI Strip (top row — 4 cards)

| KPI | Formula | Trend | Color |
| --- | --- | --- | --- |
| Today's Revenue | Sum of confirmed invoices | vs yesterday avg | Blue |
| Active Reps | GPS ping ≤ 5 min ago | vs total assigned | Green |
| Invoices Today | Count of all statuses | — | Amber |
| Pending Collections | Overdue > 7 days | Δ vs last week | Red |

### AI Morning Briefing Card

- Team-level briefing pulled from `/api/v1/ai/briefing/team`
- Generated at 05:00 local; cached; shown with age timestamp
- Lists top 3 at-risk customers, top opportunity rep, today's revenue forecast
- CTA: "Ask AI" → opens inline chat pre-loaded with team context
- Confidence badge + "Why?" reasoning sheet

### Live Activity Feed (right column)

- WebSocket stream of: new invoice saved, anomaly flagged, cheque scanned, route deviation
- Color-coded by severity; oldest items fade out after 2 min
- Clicking any event deep-links to the relevant record

### Rep Status Grid (bottom)

- Card per rep: avatar, name, last-GPS timestamp, today's sales total, stop progress (x/n)
- Status dot: 🟢 online · 🟡 idle > 30 min · 🔴 offline > 2 h
- Anomaly badge if rep has ≥ 1 HIGH severity flag awaiting approval

---

### VIEW 2 · Live Map

**Purpose:** Real-time GPS visualization of all reps.

### Features

- Leaflet map with rep marker per active rep (color = status)
- Marker click → rep mini-card: today's sales, next stop, last check-in
- Cluster mode when zoomed out (MarkerClusterGroup)
- Customer pins toggleable: All | At-risk only | Unvisited today
- Route overlay: planned route vs actual GPS trail (dashed vs solid)
- **AI route-efficiency badge** on each rep marker: "On track ✓" | "17 min behind ⚠️"
- Heatmap mode: customer density or revenue density by zone
- Time scrubber: replay the day's movement (data from `rep_location_events`)
- Export: download today's GPS data as GeoJSON

---

### VIEW 3 · AI Insights Hub (🌟 Flagship Page)

**Purpose:** One screen that surfaces all 10 AI features from the manager's perspective.

### Section A — Team Intelligence Briefing

- Markdown card rendered from `/api/v1/ai/briefing/team`
- Expandable per-rep briefing sub-cards
- AI chat panel: type questions about the team; SSE streaming response

### Section B — Demand Forecast Command Center

- Multi-product forecast grid: product rows × horizon columns (7d / 30d / 90d)
- Recharts sparklines with CI band
- "Request restock" bulk action for products where forecast > current stock
- Filter by product category or van assignment
- Data source: `/api/v1/ai/forecast/multi`

### Section C — Customer Churn Heatmap

- Territory map overlay with churn-risk color fill (green → amber → red)
- Side table: top 20 at-risk customers, sortable by churn score
- "Assign priority visit" action → pushes to rep's tomorrow route
- Segment distribution donut chart (6 segments from RFM)
- Source: `/api/v1/ai/churn-heatmap`

### Section D — Anomaly Approval Queue

- Table of all HIGH-severity anomaly flags awaiting manager action
- Each row: rep name, invoice amount, anomaly reason, timestamp
- Actions: Approve | Reject | Request Edit
- POST to `/api/v1/ai/anomalies/approve`
- Auto-escalation timer (SLA: approve within 2h or alert supervisor)

### Section E — Route Optimization Analytics

- Per-rep card: planned vs actual distance, time saved, adherence %
- "Re-optimize" action sends push notification to rep mobile
- Source: `/api/v1/ai/route-efficiency`

### Section F — Product Recommendations Acceptance Rate

- Table: product × rep × acceptance rate × revenue impact
- Sortable; highlights reps with < 30% acceptance rate (coaching opportunity)
- Source: telemetry POSTed from mobile to `/api/v1/ai/recommendations/feedback`

### Section G — Rep Coaching Reports

- Expandable per-rep cards showing today's coaching report (strengths / opportunities / goals)
- Manager can add a note pinned to the rep's next briefing
- Source: `/api/v1/ai/coaching/team`

### Section H — Voice & Cheque OCR Logs

- Today's processed voice orders and cheque scans, with accuracy metadata
- Flagged mismatches (amount-in-words ≠ numeric) shown prominently
- Source: `ai_voice_order_queue` + `ai_cheque_scan_queue` tables

---

### VIEW 4 · Sales Representatives

**Purpose:** Full rep management — hiring to performance.

### Features

- Data table: name, region, today's revenue, route completion %, churn-risk customers, anomaly count
- AI column: coaching score badge (🟢 improving · 🟡 plateau · 🔴 declining)
- Filters: region, status, performance quartile
- Rep detail drawer: KPI history sparklines, full coaching timeline, assigned customers map
- Actions: Edit quota · Assign route · Suspend · View mobile audit log
- Bulk assign: drag-and-drop customers between reps
- Export: CSV / Excel with any visible column set

---

### VIEW 5 · Customers

**Purpose:** Full customer master with AI-enriched attributes.

### Features

- Searchable, sortable table: name, city, segment chip, churn badge, last visit, balance
- AI columns: Segment (6 RFM chips) · Churn Risk (% + color) · LTV (minor units)
- Segment filter chips: أبطال · مخلصون · عرضة · واعدون · خاملون · عاديون
- Churn filter: All | At-risk | High-risk
- Customer detail page:
    - Header: segment + churn badge + LTV + last visit
    - AI panel: top 3 churn drivers (SHAP-style in Arabic)
    - Recommendation history: what was suggested vs accepted
    - Invoice history table
    - Collection history (paid, outstanding, overdue)
    - Map of customer location
- Actions: Add visit note · Reassign rep · Trigger AI insight refresh · Block account
- Import: bulk upload CSV (name, address, phone, category)

---

### VIEW 6 · Products

**Purpose:** Product catalog + pricing + van stock management.

### Features

- Grid + table toggle: product image, name, SKU, price, category, status
- AI badge: forecast trend arrow (↑ rising / → stable / ↓ declining) per product
- Van stock panel: per-rep van, current loaded quantity, forecasted need in 7 days
    - Color-coded: 🟢 sufficient · 🟡 borderline · 🔴 likely stockout
- Product detail page:
    - Demand forecast chart (7/30/90 toggle) with Recharts + CI shading
    - Sales velocity histogram (last 90 days)
    - Top customers for this product (by volume)
    - AI recommendation acceptance rate for this product
- Actions: Edit price · Adjust reorder point · Request van restock · Discontinue
- Pricing rules engine: bulk discount tiers, customer-segment-specific pricing

---

### VIEW 7 · Routes

**Purpose:** Daily route planning, AI-optimization dispatch, and adherence tracking.

### Features

- Date picker (default: today); rep selector or "All reps"
- Route card per rep:
    - Planned stops list (draggable to override)
    - AI-optimized toggle: shows Δ distance and Δ time from optimization
    - Actual GPS trail overlay status
    - Completion status per stop: ✓ visited · ⏳ pending · ✗ skipped
- "Generate optimized routes for tomorrow" action:
    - Calls `/api/v1/ai/route-optimize` for each active rep
    - Preview table: estimated savings per rep
    - Confirm → pushes plans to reps' morning briefing
- Route templates: save frequently used stop lists per region
- Compliance report: % of stops visited, avg deviation from plan

---

### VIEW 8 · Orders (Invoices)

**Purpose:** Full sales invoice management with anomaly integration.

### Features

- Data table: invoice #, rep, customer, date, lines count, total, status, anomaly
- Status chips: Draft · Confirmed · Pending Approval · Rejected · Cancelled
- Anomaly column: none · ⚠️ MED · 🚨 HIGH (click → reason sheet)
- Approval queue tab: HIGH-severity invoices awaiting manager sign-off
- Invoice detail drawer:
    - Line items with unit prices and discount breakdown
    - Anomaly panel: AI reasons, confidence, model version
    - Action buttons: Approve · Reject · Request Rep Edit · Override Discount
    - Audit trail (created → anomaly flagged → manager reviewed → approved)
- Bulk export: filtered date range → Excel with line-item detail
- Filters: rep, customer, date range, status, anomaly severity

---

### VIEW 9 · Collections

**Purpose:** Cash and cheque collection tracking + reconciliation.

### Features

- Summary cards: Total collected today · Cash · Cheque · Pending · Overdue
- Table: customer, rep, amount, method (cash/cheque), collection date, status
- Cheque sub-table columns: bank, cheque #, due date, OCR confidence, verified flag
- Cheque OCR review queue:
    - Rows where `server_extract_json` differs from `local_extract_json` (offline reconciliation)
    - Manager confirms the correct value → marks `reconciled_at`
    - Amount-in-words mismatch rows highlighted red and blocked from final confirm
- Overdue aging report: 0-7d · 8-30d · 31-60d · 60d+ buckets
- Batch post: mark multiple cash collections as bank-deposited
- Export: cheque clearing list for bank upload (IBAN + amount + due date)

---

### VIEW 10 · Reports & Analytics

**Purpose:** Historical analytics, scheduled exports, and KPI trend monitoring.

### Sub-sections (tabs)

**Sales Performance**

- Revenue by rep (bar chart) · by region (choropleth) · by product category (treemap)
- Period comparisons: day / week / month / quarter / custom
- Goal vs actual per rep (progress bars)
- Top N customers by revenue

**AI Accuracy Reports**

- Recommendation acceptance rate trend (line chart)
- Forecast MAPE per product (table)
- Cheque OCR field-level accuracy (bar chart)
- Voice order WER trend (line chart)
- Anomaly false-positive rate (manager-overridden HIGH flags / total HIGH flags)

**Customer Health Report**

- Segment migration matrix (Sankey: where customers moved between segments this month)
- Churn risk distribution histogram
- New customers acquired vs churned per week

**Financial Summary**

- Collections vs invoices (gap = outstanding AR)
- Overdue aging chart (stacked bar by bucket)
- Average collection days per rep

**Scheduled Exports**

- Configure daily/weekly email reports: choose metrics, reps, format (PDF/Excel)
- Report templates library (save custom filter + column configurations)

---

### VIEW 11 · Settings

**Purpose:** Tenant configuration, user management, AI controls, and integrations.

### Sub-sections

- **Users & Roles:** Add/edit/deactivate users; role assignment (admin/manager/supervisor/viewer)
- **AI Configuration:**
    - Per-rep daily quota (chat messages + inference calls)
    - AI features toggle per role (disable OCR for trial plan, etc.)
    - Whisper model deployment status (which reps have downloaded the model)
    - Gateway API key rotation (masked; show last 4 chars)
    - AI audit log: all AI calls with rep, timestamp, feature, cost estimate
- **Product Catalog:** Default categories, unit types, SKU prefix, price list version
- **Territories & Regions:** Define territory boundaries (GeoJSON upload)
- **Integrations:** ERP webhook config, accounting system export format, SMS gateway
- **Notifications:** Alert rules (anomaly → email, churn spike → WhatsApp)
- **Branding:** Company logo, colors for printed invoices
- **Audit Log:** Full system audit (who changed what, when)

---

## PART 3 — DATABASE SCHEMA

> Engine: PostgreSQL 15+
> 
> 
> UUID strategy: `gen_random_uuid()` for all public-facing IDs
> 
> All timestamps: `TIMESTAMPTZ` (UTC stored, displayed in tenant timezone)
> 
> Soft deletes: `deleted_at TIMESTAMPTZ` on all master tables
> 
> Row-Level Security (RLS) enforced per tenant via `tenant_id`
> 

---

### 3.1 — TENANTS & AUTH

```
-- ─────────────────────────────────────────────
-- TENANTS
-- ─────────────────────────────────────────────
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    plan            TEXT NOT NULL DEFAULT 'starter',  -- starter | pro | enterprise
    timezone        TEXT NOT NULL DEFAULT 'Asia/Amman',
    locale          TEXT NOT NULL DEFAULT 'ar',
    ai_chat_quota   INTEGER NOT NULL DEFAULT 200,
    ai_infer_quota  INTEGER NOT NULL DEFAULT 1000,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
-- USERS (managers, admins, supervisors)
-- ─────────────────────────────────────────────
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    email           TEXT NOT NULL,
    name_ar         TEXT NOT NULL,
    name_en         TEXT,
    role            TEXT NOT NULL,   -- admin | manager | supervisor | viewer
    region_id       UUID,            -- nullable; scopes a manager to one region
    avatar_url      TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    UNIQUE (tenant_id, email)
);

-- ─────────────────────────────────────────────
-- SALES REPRESENTATIVES (field reps)
-- ─────────────────────────────────────────────
CREATE TABLE reps (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    user_id         UUID REFERENCES users(id),  -- nullable if rep has no dashboard access
    name_ar         TEXT NOT NULL,
    name_en         TEXT,
    phone           TEXT,
    region_id       UUID,
    van_id          UUID,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    hire_date       DATE,
    daily_quota_jod INTEGER,            -- in minor units (fils)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);
```

---

### 3.2 — TERRITORIES & GEOGRAPHY

```
CREATE TABLE regions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    name_ar     TEXT NOT NULL,
    name_en     TEXT,
    boundary    GEOGRAPHY(POLYGON, 4326),  -- PostGIS
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rep_location_events (
    id          BIGSERIAL PRIMARY KEY,
    rep_id      UUID NOT NULL REFERENCES reps(id),
    tenant_id   UUID NOT NULL,
    lat         DOUBLE PRECISION NOT NULL,
    lng         DOUBLE PRECISION NOT NULL,
    accuracy_m  REAL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Partition by recorded_at (monthly); index on (rep_id, recorded_at DESC)
CREATE INDEX ON rep_location_events (rep_id, recorded_at DESC);
```

---

### 3.3 — CUSTOMERS

```
CREATE TABLE customers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    rep_id          UUID REFERENCES reps(id),
    name_ar         TEXT NOT NULL,
    name_en         TEXT,
    phone           TEXT,              -- stored hashed for AI calls
    phone_hash      TEXT,              -- HMAC-SHA256 salted
    address_ar      TEXT,
    city            TEXT,
    region_id       UUID REFERENCES regions(id),
    lat             DOUBLE PRECISION,
    lng             DOUBLE PRECISION,
    category        TEXT,              -- retail | wholesale | horeca | pharmacy …
    credit_limit    INTEGER,           -- minor units
    payment_terms   INTEGER DEFAULT 30,-- days
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

-- AI-enriched customer attributes (updated by AI pipeline nightly)
CREATE TABLE customer_ai_profile (
    customer_id         UUID PRIMARY KEY REFERENCES customers(id),
    segment             TEXT NOT NULL,   -- RFM segment key
    churn_score         REAL NOT NULL,   -- 0.0 – 1.0
    churn_risk_label    TEXT NOT NULL,   -- loyal | at_risk | high_risk
    ltv_estimate        INTEGER,         -- minor units; lifetime value estimate
    shap_drivers_json   JSONB,           -- top 5 SHAP features in Arabic
    model_version       TEXT NOT NULL,
    computed_at         TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Customer visit log (from mobile check-in events)
CREATE TABLE customer_visits (
    id              BIGSERIAL PRIMARY KEY,
    customer_id     UUID NOT NULL REFERENCES customers(id),
    rep_id          UUID NOT NULL REFERENCES reps(id),
    tenant_id       UUID NOT NULL,
    visited_at      TIMESTAMPTZ NOT NULL,
    had_sale        BOOLEAN NOT NULL DEFAULT FALSE,
    visit_note      TEXT,
    lat             DOUBLE PRECISION,
    lng             DOUBLE PRECISION
);
```

---

### 3.4 — PRODUCTS & INVENTORY

```
CREATE TABLE product_categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    name_ar     TEXT NOT NULL,
    name_en     TEXT,
    parent_id   UUID REFERENCES product_categories(id),
    sort_order  INTEGER DEFAULT 0
);

CREATE TABLE products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    sku             TEXT NOT NULL,
    name_ar         TEXT NOT NULL,
    name_en         TEXT,
    category_id     UUID REFERENCES product_categories(id),
    unit            TEXT NOT NULL DEFAULT 'carton',
    price           INTEGER NOT NULL,          -- minor units (fils)
    cost            INTEGER,
    barcode         TEXT,
    image_url       TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    reorder_qty     INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    UNIQUE (tenant_id, sku)
);

-- Per-rep van stock snapshot
CREATE TABLE van_stock (
    id          BIGSERIAL PRIMARY KEY,
    rep_id      UUID NOT NULL REFERENCES reps(id),
    product_id  UUID NOT NULL REFERENCES products(id),
    quantity    INTEGER NOT NULL DEFAULT 0,
    loaded_at   TIMESTAMPTZ,
    snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (rep_id, product_id)
);

-- Pricing tiers
CREATE TABLE price_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    product_id      UUID REFERENCES products(id),   -- NULL = applies to all
    customer_segment TEXT,                            -- NULL = all segments
    min_qty         INTEGER NOT NULL DEFAULT 1,
    discount_pct    REAL NOT NULL DEFAULT 0,
    fixed_price     INTEGER,                          -- overrides if set
    valid_from      DATE,
    valid_to        DATE
);
```

---

### 3.5 — ROUTES

```
CREATE TABLE route_plans (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rep_id          UUID NOT NULL REFERENCES reps(id),
    tenant_id       UUID NOT NULL,
    plan_date       DATE NOT NULL,
    source          TEXT NOT NULL DEFAULT 'manual',  -- manual | ai_optimized
    ai_est_distance REAL,            -- km
    ai_est_duration INTEGER,         -- minutes
    ai_savings_min  INTEGER,         -- minutes saved vs naive order
    accepted_at     TIMESTAMPTZ,     -- when rep accepted the AI route
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (rep_id, plan_date)
);

CREATE TABLE route_stops (
    id              BIGSERIAL PRIMARY KEY,
    plan_id         UUID NOT NULL REFERENCES route_plans(id),
    customer_id     UUID NOT NULL REFERENCES customers(id),
    stop_order      INTEGER NOT NULL,
    est_arrival     TIMESTAMPTZ,
    est_duration_min INTEGER DEFAULT 20,
    actual_arrival  TIMESTAMPTZ,
    actual_departure TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending | visited | skipped
    skip_reason     TEXT
);
```

---

### 3.6 — SALES (INVOICES & LINES)

```
CREATE TABLE invoices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    rep_id          UUID NOT NULL REFERENCES reps(id),
    customer_id     UUID NOT NULL REFERENCES customers(id),
    invoice_number  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'draft',
                    -- draft | confirmed | pending_approval | rejected | cancelled
    subtotal        INTEGER NOT NULL DEFAULT 0,    -- minor units
    discount_amount INTEGER NOT NULL DEFAULT 0,
    tax_amount      INTEGER NOT NULL DEFAULT 0,
    total           INTEGER NOT NULL DEFAULT 0,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at    TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,
    device_id       TEXT,                          -- mobile device identifier
    UNIQUE (tenant_id, invoice_number)
);

CREATE TABLE invoice_lines (
    id              BIGSERIAL PRIMARY KEY,
    invoice_id      UUID NOT NULL REFERENCES invoices(id),
    product_id      UUID NOT NULL REFERENCES products(id),
    quantity        INTEGER NOT NULL,
    unit_price      INTEGER NOT NULL,              -- minor units
    discount_pct    REAL NOT NULL DEFAULT 0,
    line_total      INTEGER NOT NULL
);

-- Approval audit trail
CREATE TABLE invoice_approvals (
    id              BIGSERIAL PRIMARY KEY,
    invoice_id      UUID NOT NULL REFERENCES invoices(id),
    action          TEXT NOT NULL,  -- submitted | approved | rejected | override
    actor_id        UUID REFERENCES users(id),
    reason          TEXT,
    acted_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 3.7 — COLLECTIONS

```
CREATE TABLE collections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    rep_id          UUID NOT NULL REFERENCES reps(id),
    customer_id     UUID NOT NULL REFERENCES customers(id),
    invoice_id      UUID REFERENCES invoices(id),
    amount          INTEGER NOT NULL,              -- minor units
    method          TEXT NOT NULL,                 -- cash | cheque
    status          TEXT NOT NULL DEFAULT 'pending',
                    -- pending | confirmed | deposited | bounced
    collected_at    TIMESTAMPTZ NOT NULL,
    confirmed_at    TIMESTAMPTZ,
    deposited_at    TIMESTAMPTZ,
    note            TEXT
);

CREATE TABLE cheques (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id   UUID NOT NULL REFERENCES collections(id),
    bank_name       TEXT,
    cheque_number   TEXT,
    payee           TEXT,
    amount          INTEGER NOT NULL,
    amount_words    TEXT,
    due_date        DATE,
    ocr_confidence  REAL,
    words_match     BOOLEAN,         -- TRUE if numeric amount matches words
    scan_source     TEXT NOT NULL,   -- server | mlkit_offline
    status          TEXT NOT NULL DEFAULT 'pending',
                    -- pending | cleared | bounced | cancelled
    image_path      TEXT,
    scanned_at      TIMESTAMPTZ
);
```

---

### 3.8 — AI FEATURES (SERVER-SIDE TABLES)

```
-- ─────────────────────────────────────────────
-- AI TEAM BRIEFINGS (manager-facing)
-- ─────────────────────────────────────────────
CREATE TABLE ai_team_briefings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    briefing_date   DATE NOT NULL,
    summary_md      TEXT NOT NULL,           -- full markdown briefing
    alerts_json     JSONB,                   -- structured alert list
    forecast_total  INTEGER,                 -- today's revenue forecast (minor units)
    model_version   TEXT,
    generated_at    TIMESTAMPTZ NOT NULL,
    UNIQUE (tenant_id, briefing_date)
);

-- ─────────────────────────────────────────────
-- DEMAND FORECASTS (per product, per tenant)
-- ─────────────────────────────────────────────
CREATE TABLE ai_demand_forecasts (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    product_id      UUID NOT NULL REFERENCES products(id),
    horizon_days    INTEGER NOT NULL,        -- 7 | 30 | 90
    points_json     JSONB NOT NULL,          -- [{date, value, ci_low, ci_high}]
    mape            REAL,                    -- Mean Absolute Percentage Error
    model_version   TEXT NOT NULL,
    generated_at    TIMESTAMPTZ NOT NULL,
    UNIQUE (tenant_id, product_id, horizon_days)
);

-- ─────────────────────────────────────────────
-- PRODUCT RECOMMENDATION TELEMETRY
-- ─────────────────────────────────────────────
CREATE TABLE ai_recommendation_events (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    rep_id          UUID NOT NULL REFERENCES reps(id),
    customer_id     UUID NOT NULL REFERENCES customers(id),
    product_id      UUID NOT NULL REFERENCES products(id),
    recommended_qty INTEGER NOT NULL,
    score           REAL NOT NULL,
    confidence      REAL NOT NULL,
    reasoning_tags  TEXT[],
    accepted        BOOLEAN,                 -- NULL = no action taken
    actual_qty      INTEGER,                 -- NULL until sale confirmed
    recommended_at  TIMESTAMPTZ NOT NULL,
    acted_at        TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
-- ANOMALY LOG (server-side master)
-- ─────────────────────────────────────────────
CREATE TABLE ai_anomaly_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    invoice_id      UUID NOT NULL REFERENCES invoices(id),
    rep_id          UUID NOT NULL REFERENCES reps(id),
    severity        TEXT NOT NULL,           -- low | med | high
    reasons_json    JSONB NOT NULL,          -- list of reason strings
    confidence      REAL,
    model_version   TEXT,
    detected_by     TEXT NOT NULL,           -- server | local
    detected_at     TIMESTAMPTZ NOT NULL,
    reviewed_by     UUID REFERENCES users(id),
    review_action   TEXT,                    -- approved | rejected | override
    reviewed_at     TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
-- ROUTE OPTIMIZATION LOG
-- ─────────────────────────────────────────────
CREATE TABLE ai_route_optimizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id         UUID NOT NULL REFERENCES route_plans(id),
    rep_id          UUID NOT NULL REFERENCES reps(id),
    input_stops     INTEGER NOT NULL,
    optimized_order INTEGER[] NOT NULL,      -- ordered stop IDs
    est_distance_km REAL NOT NULL,
    est_duration_min INTEGER NOT NULL,
    naive_distance_km REAL,
    naive_duration_min INTEGER,
    model_version   TEXT NOT NULL,
    generated_at    TIMESTAMPTZ NOT NULL
);

-- ─────────────────────────────────────────────
-- COACHING REPORTS (server-side)
-- ─────────────────────────────────────────────
CREATE TABLE ai_coaching_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    rep_id          UUID NOT NULL REFERENCES reps(id),
    report_date     DATE NOT NULL,
    strengths_json  JSONB NOT NULL,          -- [{text_ar, text_en}]
    opportunities_json JSONB NOT NULL,
    goals_json      JSONB NOT NULL,
    kpis_json       JSONB,                   -- {actual, avg7d, avg30d}
    model_version   TEXT NOT NULL,
    generated_at    TIMESTAMPTZ NOT NULL,
    read_at         TIMESTAMPTZ,             -- when rep dismissed on mobile
    manager_note    TEXT,
    UNIQUE (tenant_id, rep_id, report_date)
);

-- ─────────────────────────────────────────────
-- VOICE ORDER QUEUE (server receives from mobile)
-- ─────────────────────────────────────────────
CREATE TABLE ai_voice_order_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    rep_id          UUID NOT NULL REFERENCES reps(id),
    customer_id     UUID REFERENCES customers(id),
    audio_url       TEXT NOT NULL,           -- S3 / object-store path
    duration_sec    REAL,
    transcript      TEXT,
    parsed_lines_json JSONB,
    wer_estimate    REAL,
    model_version   TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
                    -- pending | transcribed | applied | failed
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    transcribed_at  TIMESTAMPTZ,
    applied_to_invoice UUID REFERENCES invoices(id)
);

-- ─────────────────────────────────────────────
-- CHEQUE SCAN QUEUE (server receives from mobile)
-- ─────────────────────────────────────────────
CREATE TABLE ai_cheque_scan_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    rep_id          UUID NOT NULL REFERENCES reps(id),
    collection_id   UUID REFERENCES collections(id),
    image_url       TEXT NOT NULL,           -- S3 path
    local_extract_json  JSONB,               -- ML Kit offline result
    server_extract_json JSONB,               -- Vision API result
    field_confidences_json JSONB,            -- {bank, number, amount, date, payee}
    reconciled_json JSONB,                   -- final confirmed values
    words_mismatch  BOOLEAN DEFAULT FALSE,
    status          TEXT NOT NULL DEFAULT 'pending',
                    -- pending | extracted | reconciled | failed
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    extracted_at    TIMESTAMPTZ,
    reconciled_at   TIMESTAMPTZ,
    reconciled_by   UUID REFERENCES users(id)
);

-- ─────────────────────────────────────────────
-- AI CHAT CONVERSATIONS (server-synced from mobile)
-- ─────────────────────────────────────────────
CREATE TABLE ai_conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    rep_id          UUID REFERENCES reps(id),       -- NULL if manager-initiated
    user_id         UUID REFERENCES users(id),       -- NULL if rep-initiated
    title           TEXT,
    context_json    JSONB,                           -- screen context at creation
    is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES ai_conversations(id),
    role            TEXT NOT NULL,                   -- user | assistant
    content         TEXT NOT NULL,
    model_version   TEXT,
    token_count     INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────
-- AI QUOTA USAGE TRACKING
-- ─────────────────────────────────────────────
CREATE TABLE ai_quota_usage (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    rep_id          UUID REFERENCES reps(id),
    user_id         UUID REFERENCES users(id),
    feature         TEXT NOT NULL,  -- chat | recommend | forecast | ocr | voice | anomaly | route | briefing | coaching
    usage_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    call_count      INTEGER NOT NULL DEFAULT 0,
    token_count     INTEGER NOT NULL DEFAULT 0,
    cost_estimate   NUMERIC(10,4),  -- USD
    UNIQUE (tenant_id, rep_id, user_id, feature, usage_date)
);
```

---

### 3.9 — SYSTEM / AUDIT

```
-- ─────────────────────────────────────────────
-- AUDIT LOG (all user actions on dashboard)
-- ─────────────────────────────────────────────
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   UUID NOT NULL,
    actor_id    UUID REFERENCES users(id),
    entity      TEXT NOT NULL,       -- invoices | customers | reps | ai_anomaly_log …
    entity_id   TEXT NOT NULL,
    action      TEXT NOT NULL,       -- create | update | delete | approve | reject
    diff_json   JSONB,               -- before/after values
    ip_address  INET,
    user_agent  TEXT,
    acted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────
-- NOTIFICATION RULES
-- ─────────────────────────────────────────────
CREATE TABLE notification_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    name        TEXT NOT NULL,
    trigger     TEXT NOT NULL,  -- anomaly_high | churn_spike | rep_offline | overdue
    threshold   JSONB,          -- trigger-specific params
    channel     TEXT NOT NULL,  -- email | sms | whatsapp | push
    recipients  UUID[],         -- user IDs
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 3.10 — KEY INDEXES

```
-- Customers: full-text search
CREATE INDEX ON customers USING GIN (to_tsvector('arabic', name_ar));

-- Invoices: common filters
CREATE INDEX ON invoices (tenant_id, rep_id, created_at DESC);
CREATE INDEX ON invoices (tenant_id, status, created_at DESC);
CREATE INDEX ON invoices (tenant_id, customer_id);

-- Anomaly log: approval queue
CREATE INDEX ON ai_anomaly_log (tenant_id, severity, reviewed_at)
  WHERE reviewed_at IS NULL;

-- Churn profile: risk queries
CREATE INDEX ON customer_ai_profile (churn_score DESC);

-- Quota: daily lookup
CREATE INDEX ON ai_quota_usage (tenant_id, rep_id, usage_date);

-- Location events: live map
CREATE INDEX ON rep_location_events (tenant_id, recorded_at DESC)
  WHERE recorded_at > now() - INTERVAL '24 hours';

-- Forecasts: product lookup
CREATE INDEX ON ai_demand_forecasts (tenant_id, product_id, horizon_days);
```

---

## PART 4 — API ENDPOINT MAP (Dashboard → Backend)

### Core Operations

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/reps` | List reps with filters |
| GET | `/api/v1/reps/:id/kpis` | Rep KPI history |
| GET | `/api/v1/customers` | Customer list + AI profile |
| GET | `/api/v1/customers/:id/insights` | Full customer AI panel |
| GET | `/api/v1/products` | Product catalog + stock |
| GET | `/api/v1/invoices` | Invoice list + anomaly fields |
| POST | `/api/v1/invoices/:id/approve` | Manager approval |
| GET | `/api/v1/collections` | Collection list |
| GET | `/api/v1/routes` | Route plans by date/rep |
| POST | `/api/v1/routes/generate` | Trigger AI route generation |

### AI Endpoints (Dashboard Layer)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/ai/briefing/team` | Team-level briefing |
| GET | `/api/v1/ai/anomalies` | Today's anomaly queue |
| POST | `/api/v1/ai/anomalies/approve` | Approve / reject anomaly |
| GET | `/api/v1/ai/churn-heatmap` | Churn risk aggregated |
| GET | `/api/v1/ai/coaching/team` | All rep coaching reports |
| POST | `/api/v1/ai/forecast/multi` | Batch demand forecast |
| GET | `/api/v1/ai/route-efficiency` | Route adherence per rep |
| POST | `/api/v1/ai/chat` (SSE) | Manager chat assistant |
| GET | `/api/v1/ai/quota/usage` | Quota dashboard per rep |

### WebSocket Events (wss://.../ws/ops)

| Event | Direction | Payload |
| --- | --- | --- |
| `rep.location` | server → client | `{rep_id, lat, lng, ts}` |
| `invoice.created` | server → client | `{invoice_id, rep_id, total}` |
| `anomaly.flagged` | server → client | `{anomaly_id, severity, invoice_id}` |
| `cheque.scanned` | server → client | `{cheque_id, confidence}` |
| `rep.offline` | server → client | `{rep_id, last_seen}` |
| `route.deviated` | server → client | `{rep_id, deviation_km}` |

---

## PART 5 — NON-FUNCTIONAL REQUIREMENTS (Dashboard)

| Category | Requirement |
| --- | --- |
| **Initial load** | ≤ 2.5s on 4G; code-split by route; dashboard view ≤ 150 KB JS |
| **Realtime latency** | WebSocket events rendered ≤ 500ms after server emit |
| **AI streaming** | First token displayed ≤ 1.5s; token-by-token render |
| **Table rendering** | 10,000-row virtual table scrolls at 60 fps |
| **Map performance** | 50 simultaneous rep markers + customer pins without jank |
| **RTL correctness** | All layouts pass visual regression tests in RTL mode |
| **Accessibility** | WCAG 2.1 AA; all tables have ARIA; keyboard-navigable |
| **Security** | RLS enforced DB-side; no tenant data cross-contamination |
| **Uptime SLA** | 99.9% excluding AI gateway |

---

## PART 6 — DEVELOPMENT PHASES (Dashboard)

| Phase | Scope |
| --- | --- |
| **D1 — Shell** | Vite project, routing, sidebar, auth guard, design tokens, i18n setup |
| **D2 — Core Views** | Dashboard overview, Reps, Customers, Products (static data) |
| **D3 — Live Operations** | Live Map (WebSocket), Orders + approval queue, Collections |
| **D4 — AI Hub** | AI Insights Hub — all 8 sections; anomaly approval; chat |
| **D5 — Analytics** | Reports view — all 4 sub-sections; scheduled exports |
| **D6 — Settings** | Tenant config, AI quota dashboard, user management |
| **D7 — Hardening** | E2E tests, RTL regression, load tests, accessibility audit |