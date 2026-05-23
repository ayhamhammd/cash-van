# API — Plan 10 · Realtime WebSocket (`/ws/ops`)

Not REST — a Socket.io namespace that streams operational events to dashboard
clients. Single-tenant / single-instance: events broadcast to all authenticated
clients (no Redis adapter, no rooms).

## Connect

```ts
import { io } from 'socket.io-client';

const socket = io('http://<host>:3000/ws/ops', {
  auth: { token: '<jwt>' },     // or ?token= / Authorization: Bearer
  transports: ['websocket'],
});

socket.on('rep.location',     (p) => { /* live map marker */ });
socket.on('invoice.created',  (p) => { /* activity feed */ });
socket.on('invoice.confirmed',(p) => { /* activity feed */ });
socket.on('route.deviated',   (p) => { /* alert */ });
socket.on('rep.offline',      (p) => { /* status dot */ });
```

**Auth:** the JWT is verified at handshake (`auth.token`, `?token=`, or
`Authorization: Bearer`). A missing/invalid token → the server disconnects the
socket immediately and it receives no events.

## Server → client events

| Event | Payload | Source |
|---|---|---|
| `rep.location` | `{ rep_id, lat, lng, ts }` | every GPS ping (plan 02) |
| `invoice.created` | `{ invoice_id, rep_id }` | invoice draft created (plan 06) |
| `invoice.confirmed` | `{ invoice_id, rep_id, customer_id, total }` | invoice confirmed (plan 06) |
| `route.deviated` | `{ rep_id, plan_id, deviation_m }` | rep strayed > 500m from stops (plan 05) |
| `rep.offline` | `{ rep_id, last_seen }` | no ping in 2h (heartbeat watchdog) |
| `anomaly.flagged` | `{ ... }` | plan 08 (reserved, not yet emitted) |
| `cheque.scanned` | `{ ... }` | plan 08 (reserved, not yet emitted) |

Events are forwarded from the internal `EventEmitter2` bus by
`EventBridgeService`, so any feature emitting these domain events automatically
reaches WebSocket clients.

## Heartbeat watchdog

`HeartbeatWatchdogService` runs every 60s: for each active rep whose latest
`rep_location_events.recorded_at` is older than 2h, it emits `rep.offline`
once (debounced — re-fires only after the rep pings again).

## Scale-out (future)

For multiple app instances, add a Socket.io Redis adapter so a broadcast on one
instance reaches clients on another. Single-instance deployments need nothing.

## Smoke test helper

`scripts/ws-smoke.js <jwt> [waitMs]` connects, logs received events, and exits.
Run inside the container: `docker compose exec app node scripts/ws-smoke.js <jwt>`.
