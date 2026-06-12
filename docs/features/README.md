# VanFlow Feature Pack — Specs Index

Detailed build specs for the next wave of features, written for the three codebases:

| Repo | Role |
|------|------|
| `cash-van-dashboard` (this repo) | NestJS + PostgreSQL backend (`/api/v1`) |
| `cash-van-dashboard-frontend` | Next.js 15 office dashboard (Arabic-RTL) |
| `FlowVan` (AndroidStudioProjects/FlowVan) | KMP Compose salesman app (offline-first) |

## Specs

| # | Feature | Spec | Effort | Depends on |
|---|---------|------|--------|------------|
| F2 | Targets & Commission Engine | [F2-targets-commissions.md](F2-targets-commissions.md) | M | — |
| F3 | Geofenced Visit Verification | [F3-geofence-visit-verification.md](F3-geofence-visit-verification.md) | S–M | — |
| F4 | Cheque Lifecycle & Bounce Alerts | [F4-cheque-lifecycle.md](F4-cheque-lifecycle.md) | M | F10 (notifications, optional) |
| F5 | Speeding & Driver Behavior | [F5-driver-behavior.md](F5-driver-behavior.md) | S | — |
| F7 | Van Stock Audit (Spot Count) | [F7-van-stock-audit.md](F7-van-stock-audit.md) | M | — |
| F10 | Approvals, Notifications & Salesman Permissions | [F10-approvals-notifications-permissions.md](F10-approvals-notifications-permissions.md) | **L** | build **first** — F4/F2 reuse its notification bus |
| F11 | Operations Hub (العمليات) — replaces the Vouchers tab | [F11-operations-hub.md](F11-operations-hub.md) | M–L | none (F10 already live) |

## Status

Live tracker: [PROGRESS.md](PROGRESS.md)

## Recommended build order

1. **F10** — the approval-request bus + salesman permission flags are infrastructure every
   other feature notifies through; building it first avoids rework.
2. **F3** — pure backend check + a flag column; instantly feeds the F10 notification bell.
3. **F5** — small: thresholds over data the trips report already computes.
4. **F2** — targets UI + commission math; gamifies mobile Home.
5. **F4** — cheque board + reminders (uses F10 push).
6. **F7** — van stock audit flow (mobile-heavy).

## Conventions all specs follow

- Money: vouchers/reports in **JOD major** `numeric(14,2)`; products/collections in **fils**. Render mono-LTR.
- API: success envelope `{ success, data, timestamp }`; strict query-param whitelists; offset/limit pagination.
- Realtime: Socket.IO namespace `/ws/ops`, events bridged via `EventEmitter2` → `EventBridgeService`.
- RBAC: backend `@Roles()` / `@RequirePermissions()`; dashboard `<Can role|perm>`; mobile gates by flags in the login payload.
- i18n: every dashboard string in `src/lib/i18n/dictionaries.ts` (ar + en); mobile strings in Compose resources.
- Migrations: hand-written under `src/database/migrations/` (no synchronize).
