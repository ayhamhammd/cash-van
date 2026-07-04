# F4 — Cheque Lifecycle & Bounce Alerts

**Effort:** M (≈ 2.5–3 dev-days) · **Depends on:** F10 for notifications (graceful without).

## 1. Why

Cheques are how Jordanian trade credit actually works. The backend already exposes
`/cheques`, `/cheques/reconcile/queue`, `/cheques/:id/mark-cleared`, `/cheques/:id/mark-bounced`
and `payment_cheques` has `due_date` — but there is **no dashboard workflow, no reminders,
and no consequence for a bounce**. A bounced cheque that doesn't immediately tighten the
customer's credit is a lesson the market teaches expensively.

## 2. User stories

- As a **manager**, I see a board of cheques: due this week, overdue, bounced — and act
  (deposit, mark cleared, mark bounced) without leaving it.
- As a **salesman**, I get "شيك مستحق غدًا لدى {customer} — حصّله أو بدّله" on my phone
  the day before due.
- As an **owner**, a bounced cheque automatically puts the customer on a watch list that
  blocks further credit sales until cleared by a manager.

## 3. Data model

`payment_cheques` currently lacks a status column (the cheques module tracks reconcile
state separately — verify exact current columns before migrating). Target state:

```sql
ALTER TABLE payment_cheques
  ADD COLUMN status text NOT NULL DEFAULT 'held',  -- held | deposited | cleared | bounced
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN bounce_reason text;
CREATE INDEX idx_payment_cheques_status_due ON payment_cheques (status, due_date);

ALTER TABLE customers
  ADD COLUMN credit_blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN credit_blocked_reason text;
```

If `mark-cleared` / `mark-bounced` already persist a status elsewhere, **consolidate onto
this column** in the same migration (single source of truth).

## 4. Backend changes

- **State machine** in cheques service: `held → deposited → cleared | bounced`;
  `bounced → cleared` allowed (replacement honored). Reject illegal jumps (409).
- **Bounce side-effects** (transaction): set customer `credit_blocked = true`,
  reason "شيك مرتجع رقم {n}"; emit `cheque.bounced` → F10 notification to managers **and**
  the owning rep.
- **Credit-block enforcement**: `VouchersService.create` — SALE with `paymentType=CREDIT`
  (or unpaid balance) for a blocked customer → 403 `CREDIT_BLOCKED` (cash sales still OK —
  you still want to sell to them, just not on credit). Manager can unblock from the
  customer drawer (`PATCH /customers/:id { creditBlocked:false }`, manager+).
- **Due-soon cron** (`@nestjs/schedule`, daily 07:00 Asia/Amman): cheques `status IN
  (held,deposited)` with `due_date` in ≤ N days (default 2, settings key
  `cheque_reminder_days`) → one notification per cheque per day to rep + managers.
  Also roll `due_date < today` into an `overdue` *computed* state (don't store it;
  derive in queries — avoids cron-vs-truth drift).
- Extend `GET /cheques` filters: `status`, `dueFrom`, `dueTo` (some exist), `repId`,
  `customerNumber`, and a `bucket=due-soon|overdue|bounced` convenience param.
- Dashboard KPI already shows "cheques due 7d" from `/reports/dashboard` — keep in sync
  with the new status (exclude cleared/bounced).

## 5. Dashboard UI

**New page `/cheques`** (nav: المبيعات, icon `CalendarClock`):
- Top KPI strip: قيد التحصيل (held+deposited Σ), مستحقة هذا الأسبوع, متأخرة, مرتجعة —
  mono JOD amounts + counts.
- **Three-column board** (or table with bucket filter chips on mobile widths):
  due-soon / overdue / bounced. Card: customer, cheque # (mono), bank, amount (mono JOD),
  due date, age, rep; actions per state: تم الإيداع / تم التحصيل / مرتجع (reason dialog).
- Bounced card shows the auto-applied "ائتمان موقوف" pill linking to the customer.
- **Customer drawer**: red banner when `credit_blocked` + unblock button (`<Can role="manager">`).
- i18n prefix `cheque.*`.

## 6. Mobile (FlowVan)

- **Home**: a "شيكات مستحقة" card (next 7 days, count + nearest due) → list screen with
  customer, amount (mono), due date, day-chip (غدًا / اليوم / متأخر in amber/red).
- Collection screen (cheque method) unchanged — but if customer is `credit_blocked`,
  sale screen shows the block banner and disables credit checkout (server enforces anyway).
- Reminders arrive through the F10 inbox/poll; no FCM needed v1.

## 7. Acceptance criteria

1. Lifecycle transitions enforced; illegal transition → 409.
2. Mark bounced → customer blocked + both notifications exist, all in one transaction.
3. Blocked customer: credit SALE → 403 `CREDIT_BLOCKED`; cash SALE posts fine; unblock
   restores credit.
4. Cron: cheque due tomorrow produces exactly one reminder per recipient per day
   (idempotency key `cheque:{id}:{date}` on notification insert).
5. Board buckets agree with `/reports/dashboard` cheque KPI.
6. `bounced → cleared` (replacement cheque honored) unblocks nothing automatically —
   unblock stays an explicit manager action (deliberate).

## 8. Test plan

Unit: state machine matrix; due-bucket derivation around timezone midnight (Asia/Amman).
E2E: register → remind (cron trigger manually) → bounce → blocked-sale 403 → unblock.
FE: board renders three buckets from fixtures; action dialogs round-trip.
