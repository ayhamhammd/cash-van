# Cash Van Backend

NestJS + PostgreSQL backend for the Cash Van mobile sales app.

## Stack

- **NestJS 10** (TypeScript, modular feature-based architecture)
- **PostgreSQL 16** + **TypeORM** (migrations, soft-delete, optimistic locking via `@VersionColumn`)
- **JWT auth** (Passport) with per-user permission flags
- **Throttler** for rate limiting, **Helmet** + **Compression** in `main.ts`
- **Swagger** at `/docs` (non-production)
- **Docker** multi-stage Dockerfile (dev / build / production)
- **docker-compose** for local dev with `app + db + pgadmin`

## Quick start

```bash
cp .env.example .env

docker compose up --build      # API on :3000, Postgres on 127.0.0.1:5432

# inside another shell:
docker compose exec app npm run migration:run
docker compose exec app npm run seed
```

Default seeded admin: `userNumber=admin`, `password=admin1234` (change immediately).

Swagger UI: <http://localhost:3000/docs>
Health: <http://localhost:3000/api/v1/health>

## Folder layout

```
src/
├── app.module.ts                  # Root composition (config, throttler, TypeORM, feature modules)
├── main.ts                        # Bootstrap (Helmet, Compression, global pipes/filters, Swagger)
├── common/
│   ├── decorators/                # @Public, @CurrentUser, @RequirePermissions
│   ├── dto/                       # PaginationDto and shared response shapes
│   ├── entities/base.entity.ts    # UUID id + createdAt/updatedAt/deletedAt/version
│   ├── filters/                   # Global HTTP exception filter (maps Postgres 23505/23503)
│   ├── guards/                    # JwtAuthGuard, PermissionsGuard (registered globally in AppModule)
│   └── interceptors/              # TransformInterceptor (uniform success envelope)
├── config/
│   ├── configuration.ts           # Typed config loader
│   ├── database.config.ts         # TypeOrmModule.forRootAsync options
│   └── validation.schema.ts       # Joi env validation (boot-time)
├── database/
│   ├── data-source.ts             # Stand-alone DataSource for CLI migrations
│   ├── migrations/                # `1715600000000-InitialSchema.ts`
│   └── seeds/run.ts               # `npm run seed`
├── health/health.controller.ts    # `/api/v1/health`
└── modules/
    ├── auth/                      # POST /auth/login, GET /auth/me
    ├── users/                     # CRUD + permission toggles + password reset
    ├── customers/                 # CRUD
    ├── vendors/                   # CRUD
    ├── warehouses/                # CRUD
    ├── items/                     # item-cart, item-switch (unit variants), expiry, item_balance view
    ├── vouchers/                  # voucher headers + lines + payments (single TX) + cheques + trans kinds
    └── year-config/               # yearly accounts config
```

## Domain model

| Table                  | Notes                                                                                          |
|------------------------|------------------------------------------------------------------------------------------------|
| `users`                | userNumber unique; 6 boolean permission flags; soft-delete + version                           |
| `customers`            | customerNumber unique; lat/lng for routing; creditLimit + totalDebt/Credit                     |
| `vendors`              | vendorNumber unique                                                                            |
| `warehouses`           | whNumber unique; debit/credit boxes                                                            |
| `item_cart`            | Catalog row (itemNumber + barcode unique, tax %)                                               |
| `item_switch`          | Per-unit barcode + sale price variant (CARTON, PIECE, …)                                       |
| `expiry_items`         | exp/in/start dates per warehouse                                                               |
| `transaction_kinds`    | Lookup (SALE, PURCHASE, RETURN_IN/OUT, …) with `sign ∈ {-1,0,1}` controlling stock effect      |
| `voucher_headers`      | userCode → users, customer/vendor numbers, totals, isPosted, isEdit                            |
| `voucher_transactions` | Per-line: qty, signed_qty, tax/disc, store; signed_qty feeds `item_balance` view               |
| `payments`             | Voucher payments (cash/cheque/transfer/card/credit)                                            |
| `payment_cheques`      | Bank, due date, cheque number unique                                                           |
| `year_config`          | Per-year account values + sale/D/R totals                                                      |
| `item_balance` (view)  | Sums `signed_qty` over **posted** vouchers, grouped by item + store                            |

## Auth & permissions

`POST /api/v1/auth/login` returns a JWT signed with `JWT_SECRET`. The token carries the
user's permission flags. Routes annotate required flags via `@RequirePermissions(...)`,
enforced by the global `PermissionsGuard`. `ADMIN` users bypass the per-permission check.

| Permission              | Used by                                       |
|-------------------------|-----------------------------------------------|
| `canMakeVoucher`        | POST/PATCH `/vouchers`, POST `/vouchers/:id/post` |
| `canEditVoucher`        | PATCH `/vouchers/:id`                         |
| `canAddCustomer`        | POST `/customers`                             |
| `canEditCustomerCredit` | PATCH `/customers/:id`                        |
| `canAddItems`           | POST/PATCH `/items`, `/items/switches`        |
| `canEditExpiry`         | POST `/items/expiry`                          |

## Voucher write path (atomic)

`POST /api/v1/vouchers` runs inside a single TypeORM transaction:

1. Look up `transaction_kinds.sign` for the header's `transKind`
2. Compute per-line `total` (after discount, pre-tax) and `net_total` (post-tax)
3. Persist header → lines → optional payments
4. `signed_qty = sign × itemQty` is stored on each line so the `item_balance` view can sum

Editing is allowed only while `is_posted = false`. Posting flips `is_posted = true`
which then makes the lines visible to the `item_balance` aggregation.

## NPM scripts

| Script                       | Purpose                            |
|------------------------------|------------------------------------|
| `npm run start:dev`          | Watch-mode dev server              |
| `npm run build`              | TypeScript compile to `dist/`      |
| `npm run start:prod`         | Run compiled `dist/main.js`        |
| `npm run migration:run`      | Apply pending migrations           |
| `npm run migration:generate` | Generate migration from entity diff |
| `npm run migration:revert`   | Revert last migration              |
| `npm run seed`               | Insert default admin + trans kinds + warehouse |
| `npm run lint`               | ESLint --fix                       |
| `npm test`                   | Jest unit tests                    |
| `npm run test:e2e`           | Jest e2e tests                     |

## Docker layout

- **Dockerfile** — 4 stages (`deps`, `dev`, `build`, `production`); non-root user in prod; built-in HEALTHCHECK.
- **docker-compose.yml** — base: `app`, `db` (with `pg_isready` healthcheck), `pgadmin` (under `tools` profile).
- **docker-compose.override.yml** — bind-mounts source for hot reload, sets `LOG_LEVEL=debug`. Loaded automatically.
- **docker-compose.prod.yml** — switches build target to `production`, drops Linux caps, sets resource limits, hides DB port.

Run production locally:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

## Environment variables (`.env`)

See `.env.example`. Required: `DB_HOST DB_PORT DB_USERNAME DB_PASSWORD DB_NAME JWT_SECRET`.
`JWT_SECRET` must be at least 16 chars or boot will abort.

## Best-practice highlights

- Boot-time env validation (Joi) — fails fast instead of crashing mid-request.
- Global `ValidationPipe` with `whitelist + forbidNonWhitelisted` (no extra fields accepted).
- Global `ThrottlerGuard` (default 100 req / 60 s / IP, tunable via env).
- Global `JwtAuthGuard` with `@Public()` opt-out — no unauthenticated route can slip through.
- All money/qty columns are `NUMERIC(p,s)` — never `float`.
- Soft-delete (`deleted_at`) + optimistic concurrency (`version`) on every domain table.
- Explicit indexes on **all** foreign-key columns (Postgres does not auto-index FKs).
- Voucher write is a single DB transaction; voucher edit is blocked once `is_posted = true`.
- Stock balance read is a database VIEW, not application-side aggregation.
