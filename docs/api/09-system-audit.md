# API — Plan 09 · System: Audit Log + Notification Rules

> Shared envelopes in [`docs/api/00.5-preflight.md`](./00.5-preflight.md).

Base URL: `/api/v1/`. All routes require `Authorization: Bearer <jwt>`.

---

## Audit log (automatic)

A global `AuditInterceptor` records **every successful mutating request**
(`POST/PATCH/PUT/DELETE`) into `audit_log` — best-effort, never blocking the
response. GETs are ignored; routes can opt out with `@SkipAudit()` (login does).

Each row: `{ id, actorId, entity, entityId, action, diffJson, ipAddress, userAgent, actedAt }`.
- `entity` = first path segment after the version (`/api/v1/customers/:id` → `customers`)
- `entityId` = route `:id`, else the created resource id, else `(collection)`
- `action` = `create` (collection POST) / `update` (PATCH/PUT or POST with `:id`) / `delete`
- `diffJson` = `{ body: <redacted request body> }` for create/update, `null` for delete (secrets like `password`/`secretKey` are masked)

Table is range-partitioned monthly by `acted_at`; the `AuditPartitionService`
ensures next month's partition on boot and on the 25th.

### `GET /api/v1/audit-log` — `@Roles('admin')`
**Query**: `entity, entityId, actorId, from, to (ISO), limit (≤200, def 50), offset`.
**Response data**: `{ items: AuditLog[], total }`. **Errors**: `400`, `401`, `403`.

### `GET /api/v1/audit-log/:entity/:entityId` — `@Roles('admin')`
Full change history (newest first, ≤200) for one record.
**Response data**: `AuditLog[]`. **Errors**: `401`, `403`.

```bash
curl "http://localhost:3000/api/v1/audit-log/customers/$CID" -H "Authorization: Bearer $TOKEN"
```

---

## Notification rules — `/api/v1/notification-rules` — `@Roles('admin','manager')`

A rule maps a `trigger` to a `channel` + recipients. The `RuleEvaluator`
listens for domain events and dispatches matching active rules. v1 channel
adapters are **log-only** (real SMTP/Twilio/WhatsApp/FCM plug into the
`NotificationDispatcher` later).

Triggers: `anomaly_high | churn_spike | rep_offline | overdue`
Channels: `email | sms | whatsapp | push`

Event sources (wired, arriving with later plans):
- `invoice.anomaly_flagged` → `anomaly_high` (plan 08)
- `rep.offline` → `rep_offline` (plan 10 heartbeat)
- `collection.overdue` → `overdue`
- `customer.churn_spike` → `churn_spike` (plan 08)

### `GET /api/v1/notification-rules`
**Response data**: `NotificationRule[]` (`{ id, name, trigger, channel, threshold, recipients, isActive, createdAt }`).

### `POST /api/v1/notification-rules`
**Body** (`CreateNotificationRuleDto`):
```ts
{ name, trigger, channel, threshold?, recipients?: uuid[], isActive? }
```
**Response** — `201`, `data: NotificationRule`. **Errors**: `400`, `401`, `403`.

### `PATCH /api/v1/notification-rules/:id`
Partial update. **Errors**: `400`, `401`, `403`, `404`.

### `DELETE /api/v1/notification-rules/:id`
`204`. **Errors**: `401`, `403`, `404`.

### `POST /api/v1/notification-rules/:id/test`
Fires the rule's trigger immediately with a synthetic payload (verifies the
dispatch path without waiting for a real event).
**Response data**: `{ matched: number }` (active rules dispatched for that trigger).
**Errors**: `401`, `403`, `404`.

```bash
curl -X POST "http://localhost:3000/api/v1/notification-rules/$RULE/test" -H "Authorization: Bearer $TOKEN"
# → dispatcher logs: [email] → ... :: [VanFlow] <rule name> :: Trigger 'anomaly_high' fired: {...}
```

---

## Swagger

All endpoints render at `/docs` under tags `audit-log` and `notification-rules`.
