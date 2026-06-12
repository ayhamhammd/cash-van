# Feature Pack — Progress Tracker

Status values: `planned` → `in-progress` → `review` → `done`. Update the table + the
per-feature checklists as work lands. One PR per checklist line is a good granularity.

_Last updated: 2026-06-12 (F10 implemented: backend + dashboard done & verified E2E; mobile plumbing done, screen pre-gating pending)._

## Summary

| # | Feature | Backend | Dashboard | Mobile | Overall |
|---|---------|---------|-----------|--------|---------|
| F10 | Approvals, Notifications & Permissions | **done** | **done** | **in-progress** | **in-progress** |
| F3 | Geofenced Visit Verification | planned | planned | n/a | **planned** |
| F5 | Speeding & Driver Behavior | planned | planned | n/a | **planned** |
| F2 | Targets & Commissions | planned | planned | planned | **planned** |
| F4 | Cheque Lifecycle | planned | planned | planned | **planned** |
| F7 | Van Stock Audit | planned | planned | planned | **planned** |

## F10 — Approvals, Notifications & Salesman Permissions
- [x] BE: permission keys in `users.permissions` (`vouchers.return.direct`, `vouchers.discount.direct`, `vouchers.discount.max:<pct>`, `vouchers.priceOverride`)
- [x] BE: `approval_requests` entity + migration (1718500000000)
- [x] BE: `notifications` entity + migration (per-user inbox, manager fan-out)
- [x] BE: ApprovalsModule — create/list/mine/approve/reject + **approve executes the voucher** (failure → honest reject with reason)
- [x] BE: events `approval.requested|decided`, `notification.created` → EventBridge → `/ws/ops`
- [x] BE: enforcement in `VouchersService.create` — 403 `APPROVAL_REQUIRED:<TYPE>`; fresh DB read (edits apply without re-login); price check tolerates item-units + active price-rules, flags undercuts only
- [x] FE: notification bell (topbar) + dropdown + unread badge + read/read-all
- [x] FE: `/approvals` queue (tabs, proposed-voucher drawer, approve/reject with reason)
- [x] FE: permission editor — "Salesman (mobile)" group in user drawer + max-discount % input
- [x] MOB: `permKeys` in login → `SessionStore.currentPermKeys` + `can()` / `discountMaxPct()`
- [x] MOB: `ApprovalRequired` error type (403 detail parse) + `ApprovalApi` (create/mine)
- [x] MOB: SyncRepository auto-converts a blocked voucher push into an approval request (works offline-first — same path)
- [ ] MOB: pre-gate UI in Sale/Return screens (hide discount/price edit, "إرسال طلب موافقة" CTA) — currently the request files automatically at sync instead
- [ ] MOB: "طلباتي" list screen + poll `/approvals/mine` in SyncScheduler for decision banners
- [x] E2E: rep w/o permission → 403 → request → manager queue + bell → approve → `RET-MAIN000025` / `INV-MAIN834428` posted → rep notified (verified by curl **and** through the dashboard UI)
- [x] E2E: discount cap — `max:5` → 4% posts (201), 6% blocked (403)

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
