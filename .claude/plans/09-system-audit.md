# Plan 09 — System: Audit Log + Notification Rules

Spec ref: Part 3.9 (adapted for single-tenant deployment)
Depends on: 01

> **No `tenant_id` / no RLS** (single-tenant). Drop `tenant_id` columns + `enable_tenant_rls()`; indexes drop the `tenant_id` prefix.
> **`diff_json`** is pragmatic: request body for create/update, null for delete. True field-level before/after diffing is per-entity future work.
> **Notification adapters** are log-only by default (real SMTP/Twilio/WhatsApp/FCM are config-driven future work). `RuleEvaluator` listeners are wired for the spec triggers; most sources (anomaly = plan 08, rep.offline = plan 10) arrive later, so the `POST /:id/test` endpoint makes the engine verifiable now.
> **Settings/integrations endpoints**: skipped — covered by the existing `/api/v1/settings` (plan 01) which already masks JoFotara creds.

## Tables

### `audit_log` (partitioned monthly by `acted_at`)
```
id BIGSERIAL,
tenant_id UUID NOT NULL, actor_id UUID FK→users,
entity TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
diff_json JSONB, ip_address INET, user_agent TEXT,
acted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
PRIMARY KEY (id, acted_at)        -- partition key must be in PK
```

### `notification_rules`
```
id UUID PK, tenant_id UUID, name TEXT, trigger TEXT, threshold JSONB,
channel TEXT, recipients UUID[], is_active BOOL, created_at TIMESTAMPTZ
```
- triggers: `anomaly_high | churn_spike | rep_offline | overdue`
- channels: `email | sms | whatsapp | push`

## Checklist

### Migration
- [ ] `<ts>-AddAuditLogAndNotificationRules.ts`
- [ ] `CREATE TABLE audit_log (...) PARTITION BY RANGE (acted_at)` with PK `(id, acted_at)`
- [ ] First partition + default partition; `@nestjs/schedule` cron creates next month's partition idempotently (same pattern as plan 02)
- [ ] Indexes:
  - [ ] `audit_log (tenant_id, entity, entity_id, acted_at DESC)`
  - [ ] `audit_log (tenant_id, actor_id, acted_at DESC)`
- [ ] `CREATE TABLE notification_rules` + index `(tenant_id, is_active, trigger)`
- [ ] Enable RLS: `SELECT enable_tenant_rls('audit_log'); SELECT enable_tenant_rls('notification_rules');`

### Audit interceptor
- [ ] `src/common/interceptors/audit.interceptor.ts`
- [ ] Captures `actor_id` from `req.user`, `ip_address` from request, `user_agent`
- [ ] On mutating verbs (POST/PATCH/PUT/DELETE) writes a row
- [ ] `diff_json` derived from before/after for PATCH; null for POST/DELETE
- [ ] Apply globally via `APP_INTERCEPTOR` provider in `app.module.ts`
- [ ] Suppress for routes annotated `@SkipAudit()` (health, login retries)

### Notification engine
- [ ] `src/modules/notifications/notifications.module.ts`
- [ ] `NotificationDispatcher` — handles outbound per `channel`
- [ ] Adapters (each pluggable; default = log-only):
  - [ ] `EmailAdapter` (Nodemailer + SMTP env vars)
  - [ ] `SmsAdapter` (Twilio or local Jordanian SMS gateway — config-driven)
  - [ ] `WhatsappAdapter` (Meta Cloud API)
  - [ ] `PushAdapter` (FCM)
- [ ] `RuleEvaluator` — listens on EventEmitter2 for:
  - [ ] `invoice.anomaly_flagged` → check `anomaly_high` rules
  - [ ] `rep.offline` (from plan 02 location heartbeat) → check `rep_offline` rules
  - [ ] `collection.overdue` (from plan 07 aging cron) → check `overdue` rules
  - [ ] `customer_ai_profile.updated` → if avg churn ↑ by N% week-over-week → `churn_spike`

### DTOs
- [ ] `CreateNotificationRuleDto`, `UpdateNotificationRuleDto`
- [ ] `AuditQueryDto` — `?entity=&entity_id=&actor_id=&from=&to=`

### Endpoints — Audit
- [ ] `GET /api/v1/audit-log` — paginated, filterable (admin only)
- [ ] `GET /api/v1/audit-log/:entity/:entity_id` — history for one record

### Endpoints — Notification Rules
- [ ] `GET /api/v1/notification-rules`
- [ ] `POST /api/v1/notification-rules`
- [ ] `PATCH /api/v1/notification-rules/:id`
- [ ] `DELETE /api/v1/notification-rules/:id`
- [ ] `POST /api/v1/notification-rules/:id/test` — fires a test notification to the configured channel/recipients

### Settings page support (dashboard view 11)
- [ ] `GET /api/v1/settings/integrations` — masked credentials view
- [ ] `PATCH /api/v1/settings/integrations` — admin updates

### Acceptance
- [ ] Edit a customer → audit row appears with before/after diff
- [ ] Create notification rule for `anomaly_high` + Slack channel (stub adapter) → trigger an anomaly → see dispatched message in logs
- [ ] `GET /audit-log/customers/<id>` returns the full history
- [ ] Migration up/down clean; partitions exist
