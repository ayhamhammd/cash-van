# Plan 10 — Realtime WebSocket (`/ws/ops`)

Spec ref: Part 4 — WebSocket Events (adapted for single-tenant, single-instance)
Depends on: 02, 05, 06 (built); 08 (later sources)

## Goal

Single WebSocket gateway streaming operational events to dashboard clients.

> **Single-tenant, single-instance:** no Redis adapter, no tenant rooms — every authenticated dashboard client belongs to the one company, so the gateway broadcasts to all connected clients. (Redis pub/sub scale-out is a future step if multiple app instances are ever run.)
> **JWT auth** on the socket handshake (`auth.token` or `?token=`); invalid/missing → connection refused.
> **Sources:** forwards events already emitted by plans 02/05/06 (`rep.location`, `invoice.created/confirmed`, `route.deviated`). `anomaly.flagged` / `cheque.scanned` arrive with plan 08; `rep.offline` is produced by this plan's heartbeat watchdog.

## Events (server → client)

| Event | Source | Payload |
|---|---|---|
| `rep.location` | plan 02 location upload | `{rep_id, lat, lng, ts}` |
| `invoice.created` | plan 06 lifecycle | `{invoice_id, rep_id, customer_id, total}` |
| `anomaly.flagged` | plan 08 anomaly service | `{anomaly_id, severity, invoice_id, rep_id}` |
| `cheque.scanned` | plan 08 cheque queue | `{cheque_id, collection_id, confidence}` |
| `rep.offline` | plan 02 heartbeat watchdog | `{rep_id, last_seen}` |
| `route.deviated` | plan 05 adherence service | `{rep_id, plan_id, deviation_km}` |

## Checklist

### Deps
- [ ] `npm i @nestjs/websockets @nestjs/platform-socket.io socket.io socket.io-redis-adapter ioredis`
- [ ] `npm i -D @types/socket.io`

### Gateway
- [ ] `src/realtime/events.gateway.ts`
  - [ ] `@WebSocketGateway({ namespace: '/ws/ops', cors: {...} })`
  - [ ] JWT auth via `WsJwtGuard` (validate token from `handshake.auth.token` or `?token=`)
  - [ ] On connect: derive `tenantId` from JWT → join room `tenant:<tenantId>`
  - [ ] Server emits via `this.server.to(room).emit(eventName, payload)`
- [ ] `src/realtime/ws-jwt.guard.ts`
- [ ] `src/realtime/realtime.module.ts`
- [ ] Register in `app.module.ts`

### Redis adapter (scale-out)
- [ ] `src/realtime/redis-adapter.factory.ts` — wires `createAdapter(pubClient, subClient)` in `main.ts`
- [ ] Add Redis env vars: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`
- [ ] Add Redis service to `docker-compose.yml`

### Event bridge
- [ ] `src/realtime/event-bridge.service.ts`
  - [ ] Subscribes to NestJS `EventEmitter2` events (previously published by plans 02/05/06/07/08)
  - [ ] Maps each to the WS event name + payload shape above
  - [ ] Calls `EventsGateway.emitToTenant(tenantId, event, payload)`

### Heartbeat watchdog
- [ ] Scheduled task (`@nestjs/schedule`) every 60s:
  - [ ] For each active rep, compute `now - max(recorded_at)` from `rep_location_events`
  - [ ] If > 2h and rep was previously online, emit `rep.offline`
  - [ ] Track state in Redis to avoid repeat-fires

### Client examples (dashboard repo, not in this PR — documented here)
```ts
import { io } from 'socket.io-client';
const socket = io('/ws/ops', { auth: { token: jwt } });
socket.on('rep.location', ({rep_id, lat, lng}) => { ... });
```

### Acceptance
- [ ] Connect via socket.io-client with valid JWT → joins tenant room
- [ ] Trigger an invoice confirm → client receives `invoice.created`
- [ ] Push a location event → client receives `rep.location` ≤ 500ms after server emit
- [ ] Spin up 2 backend instances, connect to instance A, trigger event on instance B → client still receives (Redis adapter works)
- [ ] Stop pinging rep X for 2h+ → `rep.offline` fires once (not repeatedly)
- [ ] Invalid/missing JWT → connection refused

## Non-functional reminders (spec PART 5)

- Event end-to-end latency ≤ 500ms
- Backpressure: drop oldest `rep.location` events for a tenant if its room is > 1000 events/sec
- All events must include `tenant_id` server-side filter to prevent cross-tenant leakage
