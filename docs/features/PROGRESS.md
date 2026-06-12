# Feature Pack — Progress Tracker

Status values: `planned` → `in-progress` → `review` → `done`. Update the table + the
per-feature checklists as work lands. One PR per checklist line is a good granularity.

_Last updated: 2026-06-11 (specs written, nothing started)._

## Summary

| # | Feature | Backend | Dashboard | Mobile | Overall |
|---|---------|---------|-----------|--------|---------|
| F10 | Approvals, Notifications & Permissions | planned | planned | planned | **planned** |
| F3 | Geofenced Visit Verification | planned | planned | n/a | **planned** |
| F5 | Speeding & Driver Behavior | planned | planned | n/a | **planned** |
| F2 | Targets & Commissions | planned | planned | planned | **planned** |
| F4 | Cheque Lifecycle | planned | planned | planned | **planned** |
| F7 | Van Stock Audit | planned | planned | planned | **planned** |

## F10 — Approvals, Notifications & Salesman Permissions
- [ ] BE: `rep_permissions` defaults + `users.permissions` keys (`vouchers.return.direct`, `vouchers.discount.max`, `vouchers.priceOverride`)
- [ ] BE: `approval_requests` entity + migration
- [ ] BE: `notifications` entity + migration (per-user inbox)
- [ ] BE: ApprovalsModule — create/list/approve/reject endpoints + auto-execute on approve
- [ ] BE: events `approval.requested|decided`, `notification.created` → EventBridge → `/ws/ops`
- [ ] BE: enforce permission checks inside `VouchersService.create` (server-side, not just UI)
- [ ] FE: notification bell (topbar) + inbox dropdown + unread badge
- [ ] FE: Approvals queue page (`/approvals`) with diff view + approve/reject
- [ ] FE: permission editor in user/rep create+edit drawer (toggles + max-discount %)
- [ ] MOB: permissions in login payload → SessionStore; gate return/discount/price UI
- [ ] MOB: "request approval" flow + pending banner + decision push handling
- [ ] E2E: rep without permission → request → manager approves → voucher posts

## F3 — Geofenced Visit Verification
- [ ] BE: `verified`, `distance_m` columns on `customer_visits` + migration
- [ ] BE: verification in visit/voucher create (haversine vs customer lat/lng, 200 m default, configurable in settings)
- [ ] BE: `GET /reports/visit-verification` (per rep, period, % verified)
- [ ] BE: emit `visit.unverified` → F10 notification
- [ ] FE: flag column in visits report + filter; settings field for radius
- [ ] FE: rep "trust score" on reps page

## F5 — Speeding & Driver Behavior
- [ ] BE: `settings.speed_limit_kmh` (default 100) + flag legs in `repTrips`
- [ ] BE: `GET /reports/driver-behavior` (per rep weekly: top speed, speeding events, harsh-driving proxy)
- [ ] BE: emit `trip.speeding` → F10 notification
- [ ] FE: amber speed flags in Trips tab + weekly driving-score card on rep profile

## F2 — Targets & Commissions
- [ ] BE: `rep_targets` entity + migration; commission scheme fields
- [ ] BE: CRUD `/reps/:id/targets` + `GET /reps/:id/commission?month=`
- [ ] BE: extend `/reports/rep-leaderboard` with target-attainment %
- [ ] FE: targets editor in rep drawer; attainment column + ring in leaderboard
- [ ] MOB: Home target ring + commission preview card
- [ ] E2E: quota set → sales post → attainment + commission correct

## F4 — Cheque Lifecycle
- [ ] BE: cheque `status` column (`held|deposited|cleared|bounced`) + migration backfill
- [ ] BE: due-soon cron → F10 notifications (rep + manager)
- [ ] BE: bounce action → customer watch-list flag (blocks credit, F10 notify)
- [ ] FE: `/cheques` board (due / overdue / bounced columns) + actions
- [ ] MOB: cheque reminders list ("due tomorrow") on Home
- [ ] E2E: register cheque → due reminder → mark bounced → customer blocked

## F7 — Van Stock Audit
- [ ] BE: `van_stock_audits` + `van_stock_audit_lines` entities + migration
- [ ] BE: create/submit/approve endpoints; variance computation vs `van_stock`
- [ ] BE: ADJUST voucher posting on approve (writes stock deltas)
- [ ] FE: audits list + variance report per rep/month
- [ ] MOB: guided count flow (scan → count → submit) + offline queue
- [ ] E2E: seeded variance → audit → approve → balances corrected
