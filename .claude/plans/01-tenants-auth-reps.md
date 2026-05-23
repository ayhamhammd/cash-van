# Plan 01 — Auth, Reps, App Settings

Spec ref: Part 3.1 (adapted for single-tenant deployment)
Depends on: [00.5 — Preflight](./00.5-preflight.md)

## Goal

Three things:

1. **Reps** — first-class field-workforce entity, separate from `users` (workforce ≠ logins).
2. **Roles** — `admin / manager / supervisor / viewer` layered on top of existing per-action permission flags. Optional region scoping for managers.
3. **App settings** — a **single-row** `app_settings` table holding seller TIN, JoFotara credentials, timezone, locale, AI quotas. Editable from the dashboard so admins can rotate JoFotara secrets without SSH.

> This plan was originally "Tenants, Auth, Reps." Multi-tenancy was dropped after the [self-hosted decision](../../C:/Users/NTC/.claude/projects/c--Users-NTC-projects-cash-van-backend/memory/project_deployment_model.md). No `tenants` table, no `tenant_id` columns.

## Tables

### New: `app_settings` (single row)
```
id                            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
company_name_ar               TEXT NOT NULL,
company_name_en               TEXT,
-- Seller identity (used as JoFotara accountingSupplierParty in plan 11)
seller_tin                    TEXT,
seller_address                TEXT,
seller_phone                  TEXT,
seller_city_code              TEXT,              -- e.g. JO-AM, JO-IR
timezone                      TEXT NOT NULL DEFAULT 'Asia/Amman',
locale                        TEXT NOT NULL DEFAULT 'ar',
-- AI quotas (used by plan 08)
ai_chat_quota                 INTEGER NOT NULL DEFAULT 200,
ai_infer_quota                INTEGER NOT NULL DEFAULT 1000,
-- JoFotara credentials (encrypted at rest)
jofotara_client_id            TEXT,
jofotara_secret_key_encrypted TEXT,              -- AES-GCM, key from JOFOTARA_KMS_KEY env
jofotara_sandbox              BOOLEAN NOT NULL DEFAULT TRUE,
updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_by                    UUID                                  -- FK users.id, soft
```
Single-row enforced by `CHECK (id = 1)` + `PRIMARY KEY (id)`. App layer always upserts on id=1.

### New: `reps` (field sales workforce)
```
id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
user_id           UUID REFERENCES users(id),    -- nullable; reps without dashboard access
name_ar           TEXT NOT NULL,
name_en           TEXT,
phone             TEXT,
region_id         UUID,                          -- FK added in plan 02 (regions table doesn't exist yet)
van_id            UUID,                          -- FK added in plan 04 (warehouses or van table)
is_active         BOOLEAN NOT NULL DEFAULT TRUE,
hire_date         DATE,
daily_quota_fils  INTEGER,                       -- daily revenue target, in minor units
created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
deleted_at        TIMESTAMPTZ,
version           INTEGER NOT NULL DEFAULT 1
```

### Extend: `users`
Add columns:
```
email          TEXT,                              -- nullable for now; later UNIQUE if used
name_ar        TEXT,                              -- backfill from existing `name`
name_en        TEXT,
role           TEXT NOT NULL DEFAULT 'viewer',    -- admin|manager|supervisor|viewer
region_id      UUID,                              -- FK added in plan 02
avatar_url     TEXT,
last_login_at  TIMESTAMPTZ
```

`userType` (ADMIN|MANAGER|SALES|DRIVER) is kept for backward compat with mobile/business logic. The new `role` drives dashboard RBAC and is set independently.

## Checklist

### Migration
- [ ] `<ts>-AddRepsAndAppSettings.ts`
- [ ] `CREATE TABLE app_settings ...` with `CHECK (id = 1)` and insert one default row (`company_name_ar` = `'My Company'`)
- [ ] `CREATE TABLE reps ...` with indexes on `(is_active)`, `(region_id)`, `(user_id) WHERE user_id IS NOT NULL`
- [ ] `ALTER TABLE users` add `email, name_ar, name_en, role, region_id, avatar_url, last_login_at`
- [ ] Backfill `name_ar = name` for existing users; set `role` based on `userType`:
  - `ADMIN → 'admin'`, `MANAGER → 'manager'`, others → `'viewer'`
- [ ] Check constraint: `users.role IN ('admin','manager','supervisor','viewer')`
- [ ] `down()` reverses both

### Entities
- [ ] `src/modules/settings/entities/app-settings.entity.ts`
- [ ] `src/modules/reps/entities/rep.entity.ts`
- [ ] Update `src/modules/users/entities/user.entity.ts` — add new fields, `role: UserRole` typed enum

### Crypto util (for JoFotara secret)
- [ ] `src/common/crypto/secret.util.ts`
  - [ ] `encryptSecret(plaintext: string): string` — AES-256-GCM, 12-byte IV, return base64 `iv|ciphertext|authTag`
  - [ ] `decryptSecret(ciphertext: string): string`
  - [ ] Key from `JOFOTARA_KMS_KEY` env (require 32-byte hex; throw at boot if missing/wrong length)
  - [ ] Unit tests covering roundtrip + tamper rejection
- [ ] Add `JOFOTARA_KMS_KEY` to env + validation schema (optional in dev — generate a stub if missing)

### Modules
- [ ] `src/modules/settings/settings.module.ts` + `settings.service.ts` + `settings.controller.ts`
- [ ] `src/modules/reps/reps.module.ts` + `reps.service.ts` + `reps.controller.ts`
- [ ] Register both in `app.module.ts`

### DTOs — Settings
- [ ] `UpdateAppSettingsDto` — partial update; never accepts `jofotara_secret_key_encrypted` directly
- [ ] `UpdateJoFotaraCredentialsDto` — `{ client_id, secret_key, sandbox }` (plaintext in; encrypted before write)
- [ ] `AppSettingsResponseDto` — masks `jofotara_secret_key_encrypted` to last 4 chars of original plaintext (we'll store the masked suffix alongside the ciphertext or recompute on read — see service)

### DTOs — Reps
- [ ] `CreateRepDto` — `{ name_ar, name_en?, phone?, region_id?, van_id?, user_id?, hire_date?, daily_quota_fils? }`
- [ ] `UpdateRepDto` — partial
- [ ] `RepResponseDto` — includes computed `last_seen_at: null` (real value in plan 02)

### Endpoints — Settings
- [ ] `GET /api/v1/settings` — admin only; returns app settings with JoFotara secret masked
- [ ] `PATCH /api/v1/settings` — admin only; updates non-secret fields
- [ ] `PATCH /api/v1/settings/jofotara` — admin only; rotates JoFotara client + secret; encrypts before write; returns `{ client_id, secret_last4, sandbox }`

### Endpoints — Reps
- [ ] `GET /api/v1/reps?region_id=&is_active=&q=&limit=&offset=` — list with filters
- [ ] `GET /api/v1/reps/:id`
- [ ] `POST /api/v1/reps` — admin/manager
- [ ] `PATCH /api/v1/reps/:id` — admin/manager
- [ ] `DELETE /api/v1/reps/:id` — admin only (soft delete)
- [ ] `GET /api/v1/reps/:id/kpis` — stub returning shape `{ today_revenue_fils: 0, route_completion_pct: 0, ... }`; real numbers in plan 06

### Roles guard
- [ ] `src/common/decorators/roles.decorator.ts` — `@Roles('admin', 'manager')`
- [ ] `src/common/guards/roles.guard.ts` — reads JWT `role`, allows if route has no `@Roles()` OR user's role is in the list
- [ ] Register globally via `APP_GUARD` in `app.module.ts`
- [ ] Existing `permissions.guard.ts` (per-action flags) stays — both run

### Auth changes
- [ ] Add `role` to `JwtPayload`
- [ ] Auth service: include `role: user.role` (NEW column) in JWT
- [ ] JwtStrategy: write `{ userId, role }` to UserContextService CLS (renamed from TenantContextService — see preflight cleanup)
- [ ] `UsersService` updates: on login success, set `users.last_login_at = now()`

### Seed
- [ ] Update `src/database/seeds/run.ts`:
  - Insert default `app_settings` row if not present
  - Ensure seed admin user has `role='admin'`, `name_ar='المدير'`
  - Create 2 sample reps for demo

### Acceptance / Per-feature deliverables
- [ ] Docker build clean: `docker compose run --rm --no-deps app npm run build`
- [ ] Migration runs clean on fresh DB: `docker compose run --rm app npm run migration:run`
- [ ] App boots: `docker compose logs app` shows `Nest application successfully started`
- [ ] `GET /api/v1/settings` with admin JWT returns masked JoFotara secret
- [ ] `PATCH /api/v1/settings/jofotara` rotates secret; second `GET` shows new last-4
- [ ] `POST /api/v1/reps` as admin → rep created → `GET /api/v1/reps` returns it
- [ ] Manager role cannot `DELETE /api/v1/reps/:id` (403)
- [ ] Existing login flow still works
- [ ] `docs/api/01-auth-reps-settings.md` written with all endpoints + Swagger
- [ ] `docs/test-plans/01-auth-reps-settings.md` written with cURL test steps
