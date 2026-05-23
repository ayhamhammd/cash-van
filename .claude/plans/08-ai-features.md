# Plan 08 — AI Features (server-side tables + gateway)

Spec ref: Part 3.8 + Part 1 AI Gateway + Part 4 AI endpoints
Depends on: 01, 03, 04, 05, 06

## Goal

Stand up the **AI Gateway** (`/api/v1/ai/*`) backed by spec-defined tables. The gateway is the single funnel for both mobile and dashboard AI calls — it enforces quota, caches, audits, and falls back when models are unavailable.

> **Important:** Model invocation (LLM, OCR, ASR, forecast) is **out-of-scope** for this plan. Stubs return `model_version='stub-0'` and shape-correct payloads. Real model integration is a separate epic.

## Tables (one migration, batch)

| Table | Purpose |
|---|---|
| `ai_team_briefings` | Daily team briefing markdown per tenant |
| `ai_demand_forecasts` | Per-product forecast points |
| `ai_recommendation_events` | Product-recommendation telemetry |
| `ai_anomaly_log` | Invoice anomaly flags (server master) |
| `ai_route_optimizations` | Route-opt result log |
| `ai_coaching_reports` | Daily rep coaching reports |
| `ai_voice_order_queue` | Audio → transcript → parsed lines |
| `ai_cheque_scan_queue` | Cheque OCR (local + server reconciled) |
| `ai_conversations` + `ai_messages` | Chat history |
| `ai_quota_usage` | Per-tenant/rep/feature/day call+token+cost |

(See spec section 3.8 for full DDL — replicate verbatim.)

## Checklist

### Migration
- [ ] `<ts>-AddAiFeaturesTables.ts`
- [ ] Create all 11 tables verbatim from spec 3.8
- [ ] Indexes:
  - [ ] `ai_anomaly_log (tenant_id, severity, reviewed_at) WHERE reviewed_at IS NULL`
  - [ ] `ai_demand_forecasts (tenant_id, product_id, horizon_days)`
  - [ ] `ai_quota_usage (tenant_id, rep_id, usage_date)`
  - [ ] `ai_recommendation_events (tenant_id, recommended_at DESC)`
  - [ ] `ai_messages (conversation_id, created_at)`
- [ ] Enable RLS on every `ai_*` table

### Module structure
- [ ] `src/modules/ai/ai.module.ts`
  - [ ] `AiGatewayController` — `/api/v1/ai/*` aggregator
  - [ ] Sub-services: `BriefingService`, `ForecastService`, `RecommendationService`, `AnomalyService`, `RouteOptimizeService`, `CoachingService`, `VoiceOrderService`, `ChequeScanService`, `ChatService`, `QuotaService`
- [ ] Shared providers:
  - [ ] `AiCacheService` — Redis-backed (key by `tenant_id + feature + content_hash`); fallback to in-memory LRU
  - [ ] `AiQuotaInterceptor` — pre-call gate against `ai_quota_usage`; 429 on exhausted
  - [ ] `AiAuditInterceptor` — writes to `ai_quota_usage` post-call
  - [ ] `AiModelProvider` — pluggable; v1 returns deterministic stubs

### Endpoints

**Briefings**
- [ ] `GET /api/v1/ai/briefing/team` — returns today's briefing (generates if absent)

**Forecasts**
- [ ] `POST /api/v1/ai/forecast/multi` — batch, body `{ product_ids: [], horizons: [7,30,90] }`
- [ ] `GET /api/v1/ai/forecast?product_id=&horizon=`

**Recommendations**
- [ ] `POST /api/v1/ai/recommendations` — body `{ customer_id, context }` → returns ranked products
- [ ] `POST /api/v1/ai/recommendations/feedback` — `{ recommendation_id, accepted, actual_qty? }`

**Anomalies**
- [ ] `POST /api/v1/ai/anomalies/score` — internal, called by invoice confirm (plan 06)
- [ ] `GET /api/v1/ai/anomalies` — pending queue (manager view)
- [ ] `POST /api/v1/ai/anomalies/approve` — `{ anomaly_id, action: approved|rejected|override, reason? }`

**Routes**
- [ ] `POST /api/v1/ai/route-optimize` — `{ rep_id, plan_date, stops[] }` → returns optimized order + savings
- [ ] `GET /api/v1/ai/route-efficiency?rep_id=&from=&to=`

**Coaching**
- [ ] `GET /api/v1/ai/coaching/team` — all reps' latest reports (manager)
- [ ] `GET /api/v1/ai/coaching/:rep_id` — rep's own
- [ ] `POST /api/v1/ai/coaching/:rep_id/manager-note`

**Churn**
- [ ] `GET /api/v1/ai/churn-heatmap` — aggregated by region

**Voice / Cheque OCR**
- [ ] `POST /api/v1/ai/voice/upload` — multipart audio → queued, returns `id`
- [ ] `GET /api/v1/ai/voice/:id` — status + transcript
- [ ] `POST /api/v1/ai/voice/:id/apply` — applies parsed lines to a draft invoice
- [ ] `POST /api/v1/ai/cheque/scan` — multipart image → queued, returns `id`
- [ ] `GET /api/v1/ai/cheque/:id`
- [ ] `POST /api/v1/ai/cheque/:id/reconcile` — manager confirms final values

**Chat (SSE)**
- [ ] `POST /api/v1/ai/chat` — SSE stream; creates `ai_conversations` row on first message, appends `ai_messages`
- [ ] `GET /api/v1/ai/conversations` — list per user
- [ ] `GET /api/v1/ai/conversations/:id/messages`

**Quota**
- [ ] `GET /api/v1/ai/quota/usage` — current period usage; admin sees all reps, rep sees own

### Object storage
- [ ] `src/common/storage/object-storage.service.ts` — abstracts S3/MinIO; used for audio + cheque images
- [ ] Add env vars: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`
- [ ] `docker-compose.override.yml` already used; if needed add MinIO service for dev

### Background jobs
- [ ] Add `@nestjs/bull` + Redis to deps
- [ ] Queues: `ai-voice-transcribe`, `ai-cheque-extract`, `ai-briefing-generate`, `ai-coaching-generate`, `ai-forecast-refresh`
- [ ] Daily cron at 05:00 tenant-local: enqueue team briefing + coaching report jobs

### Invariants enforced
- [ ] CACHEABLE — every read endpoint checks `AiCacheService` before invoking model
- [ ] OFFLINE-FALLBACK — when model errors, return last successful cached row tagged `stale=true`
- [ ] EXPLAINABLE — every AI response includes `model_version`, `confidence`, `reasoning_tags[]` or `shap_drivers_json`
- [ ] PRIVACY-FIRST — never send raw customer `phone` to model; use `phone_hash`; strip PII in payload builder

### Acceptance
- [ ] All 11 `ai_*` tables exist after migration
- [ ] `GET /ai/briefing/team` returns a stub briefing on first call, cached on second
- [ ] `POST /ai/forecast/multi` writes rows to `ai_demand_forecasts`
- [ ] Anomaly score endpoint integrates with invoice confirm (plan 06) — HIGH severity flips status to pending_approval
- [ ] Quota: 201st chat call in a day returns 429 with quota-exhausted code
- [ ] SSE chat streams tokens (even stub tokens) over the wire
- [ ] Voice + cheque uploads land in object storage; queue status visible
