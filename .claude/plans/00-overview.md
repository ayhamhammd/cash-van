# VanFlow Backend — Execution Plan Index

Source spec: `.claude/VanFlow — Office Dashboard & Database Full Specifi 36409bdaf50f80afb536d130e555f7ef.md`
Stack: NestJS 10 + TypeORM 0.3 + PostgreSQL 15 (existing `cash-van-backend` repo)
Strategy: **Extend existing modules**, do not replace.

> **Deployment model:** VanFlow is **self-hosted per company** — one Docker stack = one company = one Postgres DB. No multi-tenancy. Earlier versions of these plans assumed SaaS multi-tenancy; that has been undone. Where you still see `tenant_id` / RLS language in plans 02-11, **ignore it** until that plan is patched on its way to execution.

## Execution Order

Each plan is self-contained. Execute in this order — later plans depend on earlier FKs.

| # | Plan | Spec Ref | Touches existing |
|---|---|---|---|
| 00.5 | [Preflight (foundations)](./00.5-preflight.md) | — | Currency/geo utils, storage, jobs, cache, JWT v:2, user-context CLS. Multi-tenant plumbing was removed after the self-hosted decision. |
| 01 | [Auth, Reps, App Settings](./01-tenants-auth-reps.md) | 3.1 (adapted) | `users` (extend with `role`, `email`, etc.), new `reps`, new single-row `app_settings` |
| 02 | [Territories & Geography](./02-territories-geography.md) | 3.2 | new `regions`, `rep_location_events`; PostGIS |
| 03 | [Customers + AI Profile](./03-customers.md) | 3.3 | `customers` (extend), new `customer_ai_profile`, `customer_visits` |
| 04 | [Products & Inventory](./04-products-inventory.md) | 3.4 | `item_cart` (extend → `products`), new `product_categories`, `van_stock`, `price_rules` |
| 05 | [Routes](./05-routes.md) | 3.5 | new `route_plans`, `route_stops` |
| 06 | [Sales Invoices](./06-invoices.md) | 3.6 | `voucher_headers/transactions` (extend → `invoices`/`invoice_lines`), new `invoice_approvals` |
| 07 | [Collections](./07-collections.md) | 3.7 | `payments`/`payment_cheques` (extend → `collections`/`cheques`) |
| 08 | [AI Features](./08-ai-features.md) | 3.8 | new `ai_*` tables, AI Gateway controller |
| 09 | [System & Audit](./09-system-audit.md) | 3.9 | new `audit_log`, `notification_rules`, global interceptor |
| 10 | [Realtime WebSocket](./10-realtime-websocket.md) | Part 4 ws/ops | new `EventsGateway` (Socket.io) |
| 11 | [Jordan Tax & JoFotara](./11-jordan-tax-jofotara.md) | `.claude/Jordan_Tax_JoFotara_NodeJS_Spec.md` | extends `invoices`, new `credit_notes`, `tax_ledger_entries`; ISTD HTTP client |

## Cross-Cutting Conventions

- **Database stays vanilla Postgres 15** — no PostGIS image swap. Geometry is `JSONB` GeoJSON + app-side turf.js.
- **No multi-tenancy.** Each customer deploys their own stack. Skip any `tenant_id` columns / RLS in earlier plan drafts.
- **CLS still in use** via `nestjs-cls` for per-request user/role context (used by audit log, job processors). It just no longer carries a `tenantId`.
- All FKs get explicit indexes (Postgres does not auto-index FKs).
- Money in **minor units (fils)** as `INTEGER` per spec; the existing `numeric(14,2)` columns stay as-is on legacy tables. New tables use `INTEGER`.
- **Canonical money representation = INTEGER fils everywhere in DB + service layer.** JOD 1.234 ↔ 1234 fils. Conversion to/from JOD decimal strings (3 dp) happens **only** at the JoFotara JSON boundary (`JoFotaraBuilderService`). A shared util `currency.util.ts` exposes `filsToJod(n) → '1.234'` and `jodToFils(str) → 1234`. No intermediate `numeric` columns for new sales tables.
- UUID PKs via `gen_random_uuid()` (pgcrypto enabled in initial migration).
- All timestamps `TIMESTAMPTZ`.
- Soft delete via `deleted_at` (extend `BaseEntity`).
- One migration per plan, named `<timestamp>-<PlanName>.ts`.
- DTOs validated with `class-validator`; Swagger decorators required.
- Controllers guarded by `JwtAuthGuard` + role-based `PermissionsGuard`.

## How to Use These Plans

1. Open the next plan (start with 01).
2. Tick checkboxes as you complete each step.
3. Each plan ends with **Acceptance Criteria** — do not move to the next plan until they pass.
4. Run `npm run migration:run` and `npm run build` after each plan.
5. **Produce the per-feature deliverables (mandatory — see below) before declaring the plan done.**

## Per-Feature Deliverables (mandatory)

Every plan, when finished, MUST also ship the following two artifacts. These are part of "done" — a plan is not complete without them:

### 1. API Documentation
- File: `docs/api/<feature>.md` (e.g. `docs/api/01-tenants-auth-reps.md`)
- Matching `@nestjs/swagger` decorators on controllers + DTOs so `/docs` shows the same shapes. **The MD and Swagger must agree.**

**Shared envelopes — document once at the top of every API doc, then reference (do NOT repeat per endpoint):**

Success — wrapped by [`TransformInterceptor`](../../src/common/interceptors/transform.interceptor.ts):
```json
{
  "success": true,
  "data": "<T — per-endpoint payload>",
  "timestamp": "2026-05-18T10:15:00.000Z"
}
```

Error — wrapped by [`HttpExceptionFilter`](../../src/common/filters/http-exception.filter.ts), **identical shape across every endpoint**:
```json
{
  "statusCode": 409,
  "message": "Duplicate value violates unique constraint",
  "error": "ConflictError",
  "path": "/api/v1/reps",
  "timestamp": "2026-05-18T10:15:00.000Z"
}
```

Per endpoint, document:
- method · path · auth/role · summary
- **Request** — path params, query params, headers, body schema with example
- **Response** — status code(s) + the `<T>` data shape (success envelope is implicit)
- **Possible errors** — list only `<status> <errorName>` pairs that this endpoint can produce (e.g. `400 BadRequestError`, `401 UnauthorizedException`, `403 ForbiddenException`, `404 NotFoundException`, `409 ConflictError`, `422 ValidationError`, `429 ThrottlerException`, `500 InternalServerError`). The envelope shape is not redocumented.
- working `curl` example

### 2. Manual Test Guide
- File: `docs/test-plans/<feature>.md`
- Contents: ordered, checkboxed steps the user can run themselves. Each step states:
  - prerequisite state (seed data, JWT for which role)
  - the exact HTTP request (curl or `.http` snippet)
  - the expected status + response shape
  - a `[ ]` checkbox

Each plan's Acceptance Criteria implicitly include "API docs MD + Swagger written" and "Test guide MD written" — do not skip.
