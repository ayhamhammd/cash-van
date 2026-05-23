# Plan 03 — Customers + AI Profile + Visits

Spec ref: Part 3.3 (adapted for single-tenant deployment)
Depends on: [01 — Auth/Reps/Settings](./01-tenants-auth-reps.md), [02 — Territories](./02-territories-geography.md)

## Goal

Extend the existing `customers` table to spec; add AI-enrichment profile and visit log.

> **No `tenant_id` / no RLS** — single-tenant deployment. The spec draft below mentions `tenant_id` columns and `enable_tenant_rls()`; those are dropped. PII-hash and FTS still apply.

## Existing → Target Mapping

| Existing column | Action |
|---|---|
| `customer_number` UNIQUE | keep |
| `customer_name` | rename concept → keep, add `name_ar`, `name_en` |
| `location` | keep as freeform string |
| `latitude`, `longitude` (numeric) | keep, alias to `lat`, `lng` in DTOs |
| `credit_limit`, `customer_type`, `total_debt`, `total_credit` | keep |

## New columns on `customers`
```
tenant_id UUID NOT NULL FK→tenants,
rep_id UUID FK→reps,
name_ar TEXT NOT NULL,    -- backfill from customer_name
name_en TEXT,
phone TEXT,
phone_hash TEXT,           -- HMAC-SHA256 salted (PII safe for AI)
address_ar TEXT,
city TEXT,
city_code TEXT,            -- ISTD code, e.g. JO-AM, JO-IR (JoFotara accountingCustomerParty)
region_id UUID FK→regions,
category TEXT,             -- retail|wholesale|horeca|pharmacy
payment_terms INTEGER DEFAULT 30,
-- Buyer identity for JoFotara (required when invoice grand_total >= 10,000 JOD)
tin TEXT,                  -- Tax ID (B2B)
nin TEXT,                  -- National ID
passport_number TEXT,
is_active BOOLEAN DEFAULT TRUE
```
Constraint: at least one of `(tin, nin, passport_number)` must be present for invoices ≥ 10_000_000 fils. Enforced in the invoice validator (plan 11), not at DB level (allowed null for small B2C sales).

## New tables

### `customer_ai_profile`
```
customer_id UUID PK FK→customers, segment TEXT, churn_score REAL,
churn_risk_label TEXT, ltv_estimate INTEGER, shap_drivers_json JSONB,
model_version TEXT, computed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
```

### `customer_visits`
```
id BIGSERIAL PK, customer_id UUID FK→customers, rep_id UUID FK→reps,
tenant_id UUID, visited_at TIMESTAMPTZ, had_sale BOOLEAN,
visit_note TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION
```

## Checklist

### Migration
- [ ] `<ts>-ExtendCustomersAndAddAiProfile.ts`
- [ ] `ALTER TABLE customers ADD COLUMN tenant_id` then backfill from default tenant; SET NOT NULL
- [ ] Add `rep_id, name_ar, name_en, phone, phone_hash, address_ar, city, city_code, region_id, category, payment_terms, tin, nin, passport_number, is_active`
- [ ] Optional partial unique index: `CREATE UNIQUE INDEX uq_customers_tenant_tin ON customers(tenant_id, tin) WHERE tin IS NOT NULL` — prevents duplicate TIN per tenant
- [ ] Backfill `name_ar` from `customer_name`
- [ ] `CREATE INDEX ON customers (tenant_id, rep_id)`, `(tenant_id, region_id)`, `(tenant_id, category)`
- [ ] Full-text search index. Vanilla Postgres 15 has no `arabic` text-search config out of the box, so use the always-available `simple` config + `pg_trgm` for fuzzy matching:
  - [ ] `CREATE EXTENSION IF NOT EXISTS pg_trgm` (ships with postgresql-contrib, present in the standard `postgres:15` image)
  - [ ] `CREATE INDEX idx_customers_name_ar_trgm ON customers USING GIN (name_ar gin_trgm_ops)`
  - [ ] `CREATE INDEX idx_customers_name_ar_fts ON customers USING GIN (to_tsvector('simple', name_ar))`
  - [ ] Service uses `ILIKE '%q%'` + trigram for substring; `to_tsvector('simple', ...)` for token match. Document upgrade path: install snowball-arabic later for stemming.
- [ ] `CREATE TABLE customer_ai_profile` + index on `(churn_score DESC)`
- [ ] `CREATE TABLE customer_visits` + index on `(customer_id, visited_at DESC)` + `(rep_id, visited_at DESC)`
- [ ] Enable RLS: `SELECT enable_tenant_rls('customers'); SELECT enable_tenant_rls('customer_visits');`
- [ ] `customer_ai_profile` has no `tenant_id` column directly (keyed on `customer_id`). Add it for RLS: `tenant_id UUID NOT NULL` then `SELECT enable_tenant_rls('customer_ai_profile');`. Keep it in sync via a trigger that copies `tenant_id` from the parent `customers` row on insert.

### Entities
- [ ] Extend `src/modules/customers/entities/customer.entity.ts`
- [ ] `src/modules/customers/entities/customer-ai-profile.entity.ts`
- [ ] `src/modules/customers/entities/customer-visit.entity.ts`

### PII handling
- [ ] `src/common/utils/phone-hash.util.ts` — HMAC-SHA256 with secret from env
- [ ] Auto-set `phone_hash` on customer write via TypeORM `BeforeInsert/BeforeUpdate` subscriber

### DTOs
- [ ] Update `CreateCustomerDto` / `UpdateCustomerDto` to include new fields
- [ ] `CustomerInsightsDto` — bundles customer + AI profile + recent visits + recent invoices summary
- [ ] `CreateVisitDto` — `{ customer_id, visited_at?, had_sale, visit_note?, lat?, lng? }`

### Endpoints
- [ ] `GET /api/v1/customers` — add filters `?segment=&churn_risk=&region_id=&rep_id=&q=` + paging + sort
- [ ] `GET /api/v1/customers/:id`
- [ ] `GET /api/v1/customers/:id/insights` — joined with AI profile + last 10 visits + invoice totals
- [ ] `POST /api/v1/customers`
- [ ] `PATCH /api/v1/customers/:id`
- [ ] `DELETE /api/v1/customers/:id` (soft)
- [ ] `POST /api/v1/customers/:id/reassign` — `{ new_rep_id }` (manager)
- [ ] `POST /api/v1/customers/:id/visits` — log a visit
- [ ] `GET /api/v1/customers/:id/visits`
- [ ] `POST /api/v1/customers/import` — CSV upload (`name`, `address`, `phone`, `category`) using multer
- [ ] `POST /api/v1/customers/:id/refresh-ai` — manual trigger of AI profile refresh (queues job)

### Bulk operations
- [ ] CSV parser: validate row count ≤ 5000, schema-check each row
- [ ] Use a transaction; report `{inserted, skipped, errors[]}`

### Acceptance
- [ ] Migration up/down clean
- [ ] Full-text search: `GET /customers?q=أحمد` returns Arabic-name match
- [ ] AI profile upsert via internal helper, then `GET /customers/:id/insights` returns combined payload
- [ ] CSV import of 50 rows succeeds; bad rows reported but transaction holds for good rows
- [ ] `phone_hash` is set automatically; raw `phone` not returned in AI-facing endpoint payloads
