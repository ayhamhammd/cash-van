# DEPLOY — Render (free tier): migrations + ERP↔dashboard webhook

The three services on Render:

| Role | URL | Stack | DB tool |
|---|---|---|---|
| **ERP** (stock master) | `https://erp-saas-lzuv.onrender.com` | Next.js | Drizzle (`drizzle-kit migrate`) |
| **Dash API** | `https://cashvan-api-34c6.onrender.com` | NestJS | TypeORM (`migration:run`) |
| **Dashboard** (web) | `https://vanflow-dashboard-ndi1.onrender.com` | Next.js | — |

> **Free tier has no Shell and no Pre-Deploy Command.** Migrations must run either in the
> **Build Command** (auto, every deploy) or **from your laptop** against the DB's External URL.

---

## 1. Migrations are NOT auto-run — run them on every deploy

Symptom when you forget: right after a deploy, the ERP sync board shows `customer` **failed**
and every `movements:*` **failed**, while entities that don't touch new columns
(`organization`, `warehouse`, `item`, `receipts`, …) stay **ok**. That means the new code is
selecting a column the migration hasn't added yet → the ERP endpoint 500s → the dashboard
pull fails.

### Option A — Build Command migrates automatically (recommended on free tier)

Render → service → **Settings → Build Command**:

- **ERP** (Drizzle migrations are plain SQL, safe before build):
  ```
  npm install && npm run db:migrate && npm run build
  ```
  `drizzle-kit` + `dotenv` are in **dependencies** (not devDeps), so they survive a
  production install and this can't break.

- **Dash API** (compile first, then migrate the compiled data-source — no ts-node needed;
  `typeorm` + `pg` are dependencies):
  ```
  npm install && npm run build && npm run migration:run:prod
  ```

Env required at build time: ERP needs `DATABASE_URL`; Dash API needs `DB_HOST` / `DB_PORT` /
`DB_USERNAME` / `DB_PASSWORD` / `DB_NAME` / `DB_SSL=true`. If the build can't reach the DB on
the internal hostname, use the **External Database URL / host** (works from anywhere).

### Option B — one-off from your laptop (against the External DB URL)

Get each DB's **External** connection info from Render → the Postgres instance → **Connect**.

```bash
# ERP (Drizzle) — adds payment_terms_days, credit_hold, invoices.due_date, stock_movements.source
cd ~/IdeaProjects/ERP
DATABASE_URL="postgresql://…ERP-external-url…?sslmode=require" npm run db:migrate

# Dash API (TypeORM) — adds customers.credit_hold
cd ~/IdeaProjects/cash-van-dashboard
DB_HOST=<host>.render.com DB_PORT=5432 DB_USERNAME=<user> DB_PASSWORD=<pass> \
  DB_NAME=<db> DB_SSL=true npm run migration:run
```

`?sslmode=require` / `DB_SSL=true` is mandatory — Render external connections require SSL.

### After the stock-movement migration (0084) — run the catch-up ONCE

Old cash-van pushes have `source = NULL`; without this they'd be re-mirrored and double-count
stock. Seeds every `movements:*` cursor to now:

```bash
curl -X POST https://cashvan-api-34c6.onrender.com/api/v1/erp/sync/movements/catch-up \
  -H "Authorization: Bearer <admin JWT>"
```

---

## 2. Webhook — reflect any ERP change on the dashboard instantly

The ERP already calls `notifyVanflow` on every synced change (customers, items, stores, org,
pricing, and **every stock movement**). The Dash API exposes the receiver at
`POST /api/v1/erp/webhook` (shared-secret, no JWT). Just set the env vars and restart:

**ERP** (`erp-saas-lzuv`) → Environment:
```
VANFLOW_WEBHOOK_URL    = https://cashvan-api-34c6.onrender.com/api/v1/erp/webhook
VANFLOW_WEBHOOK_SECRET = <a strong shared secret>
```
**Dash API** (`cashvan-api-34c6`) → Environment:
```
ERP_WEBHOOK_SECRET = <the same secret>
```

Flow: ERP change → `notifyVanflow` POSTs the webhook → Dash API validates `x-webhook-secret`
→ schedules an immediate debounced inbound re-pull. It's best-effort; the periodic safety poll
reconciles anything dropped.

**Reverse direction** (dashboard/van → ERP) needs no webhook: posted vouchers + confirmed
collections push straight to the ERP via the outbox on create (when direct-export is on).

---

## 3. Quick checklist for any deploy that includes a new migration

1. Push code (or let Render auto-deploy the branch).
2. Ensure migrations ran (Build Command, or the laptop one-liners above).
3. If a `stock_movements` migration was included, run the movements catch-up once.
4. Confirm the ERP sync board (`GET /api/v1/erp/sync/status`) is all `ok`.
5. First time only: set the webhook env vars on both services.
