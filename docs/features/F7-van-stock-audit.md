# F7 — Van Stock Audit (Spot Count)

**Effort:** M (≈ 3 dev-days, mobile-heavy) · **Depends on:** van-stock module (exists).

## 1. Why

Between warehouse load and customer sale, stock "evaporates" — damage, theft, unsold
returns miscounted. Today the system's van balance is whatever the transactions say;
nobody compares it to physical reality. A guided count (rep self-audit or supervisor
spot-check) with a manager-approved adjustment closes the loop and tells the owner the
shrinkage number per rep per month — which alone changes behavior.

## 2. User stories

- As a **supervisor/rep**, I start an audit on a van: the app lists every SKU the system
  thinks is on board; I count (scan or tap-stepper) and submit. Partial counts allowed
  (spot-check 10 SKUs).
- As a **manager**, I review the variance sheet (system vs counted, value at cost), then
  approve → stock adjusts; or reject → recount.
- As an **owner**, a monthly shrinkage report: variance value per rep, trend.

## 3. Data model

```sql
CREATE TABLE van_stock_audits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id       uuid NOT NULL REFERENCES reps(id),
  started_by   uuid NOT NULL,             -- users.id (rep or supervisor)
  status       text NOT NULL DEFAULT 'draft', -- draft | submitted | approved | rejected
  note         text,
  reviewer     uuid,
  decided_at   timestamptz,
  adjust_voucher text,                    -- voucher_number of the posted adjustment
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE van_stock_audit_lines (
  id           bigserial PRIMARY KEY,
  audit_id     uuid NOT NULL REFERENCES van_stock_audits(id) ON DELETE CASCADE,
  item_number  text NOT NULL,
  item_name    text NOT NULL,
  system_qty   numeric(14,3) NOT NULL,    -- snapshot at count time (critical!)
  counted_qty  numeric(14,3),             -- NULL = not counted (partial audit)
  unit_cost_fils integer,                 -- snapshot for variance valuation
  UNIQUE (audit_id, item_number)
);
```

**Snapshotting `system_qty` at line-creation time** is the key design decision — sales
continue during the count; the variance must compare against the moment the line was
counted, not approval time. (Document the limitation: items sold *between* their count and
submit will show false variance; mitigated by short counts + doing them at shift start.)

## 4. API (extend reps/van-stock area or new `AuditsModule`)

| Method & path | Who | Purpose |
|---|---|---|
| `POST /reps/:repId/van-stock/audits` | rep/supervisor | Create draft; server pre-fills lines from current van stock snapshot |
| `GET /reps/:repId/van-stock/audits?status=` | manager+/owner rep | List |
| `GET /van-stock/audits/:id` | involved parties | Detail with lines + computed variance |
| `PATCH /van-stock/audits/:id/lines` | creator while draft | Bulk upsert `[{ itemNumber, countedQty }]` (offline-friendly: idempotent) |
| `POST /van-stock/audits/:id/submit` | creator | draft → submitted; emits `audit.submitted` → F10 |
| `POST /van-stock/audits/:id/approve` | manager+ | Posts an **ADJUST voucher** for non-null variances (negative = shrinkage out, positive = found stock in) against the van's store, links `adjust_voucher`; → `approved` |
| `POST /van-stock/audits/:id/reject` | manager+ | `{ reason }` → rep recounts |
| `GET /reports/shrinkage?months=3&repId?` | manager+ | Per rep per month: counted audits, variance qty, variance value (fils→JOD at cost) |

**ADJUST voucher**: reuse the voucher engine — a new `transKind 'ADJUST'` (sign per line
via from/to store like TRANSFER) so stock history stays in one ledger (`item_balance`
view picks it up automatically since it derives from voucher transactions).

## 5. Dashboard UI

- **Van Stock page**: new "عمليات الجرد" tab — table: rep, date, status pill, lines
  counted/total, variance value (mono JOD, red negative), reviewer. Row → drawer with
  the variance sheet (item, system, counted, Δ qty, Δ value) + approve/reject.
- **Reports hub**: "تقرير العجز / Shrinkage" — per rep per month bars + table.
- i18n prefix `audit.*`.

## 6. Mobile UI (FlowVan)

- Van Stock screen: new "جرد" action → **guided count flow**:
  - List of on-van SKUs with big qty steppers + a scan button (scanning a barcode jumps to
    that line); counted lines get a green check; progress "12/34 صنف".
  - Works fully offline: audit draft + lines persist in Room (`van_stock_audit_local`),
    `SyncRepository` pushes create/lines/submit in order.
  - Submit → status banner "بانتظار اعتماد المدير" (polls via the existing sync tick).
- After approval, the rep's van stock refreshes to corrected numbers (existing van-stock
  sync path).

## 7. Acceptance criteria

1. Audit pre-fills exactly the current van stock; partial counts leave `counted_qty NULL`
   and those lines never produce adjustments.
2. Approve posts one ADJUST voucher whose deltas equal the variance sheet; `item_balance`
   reflects corrected quantities immediately.
3. Reject returns to rep with reason; resubmit allowed (lines editable again).
4. Shrinkage report values variance at the snapshotted `unit_cost_fils` (not current cost).
5. Offline: full count done in airplane mode syncs and submits intact afterward.
6. Two simultaneous drafts for the same van → 409 on the second (one open audit per van).

## 8. Test plan

Unit: variance math incl. partial counts and zero-variance no-op approve.
E2E: seed van stock → count with deltas → approve → assert balances + voucher lines.
Mobile: offline queue replay test; scan-jump UX check on device.
