# F2 — Targets & Commission Engine

**Effort:** M (≈ 3 dev-days) · **Depends on:** nothing (F10 bell integration optional).

## 1. Why

`reps.daily_quota_fils` already exists in the schema and is **unused**. Salesmen who see a
live target ring and a commission counter consistently outsell ones who don't. The owner
gets attainment tracking; the manager gets an objective leaderboard; the rep gets a game.

## 2. User stories

- As a **manager**, I set a monthly sales target (JOD) and a commission scheme per rep.
- As a **salesman**, my Home shows "٦٨٪ من هدف الشهر" as a progress ring and
  "عمولتي حتى الآن: 45.200 JOD".
- As an **owner**, the leaderboard ranks by attainment %, not just raw sales (fair across
  territory sizes), and I can export commissions at month end.

## 3. Data model

### `rep_targets` (new)

```sql
CREATE TABLE rep_targets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id          uuid NOT NULL REFERENCES reps(id) ON DELETE CASCADE,
  period          text NOT NULL,                -- 'YYYY-MM' (monthly v1)
  sales_target    numeric(14,2) NOT NULL DEFAULT 0,   -- JOD major (matches voucher money)
  collection_target numeric(14,2) NOT NULL DEFAULT 0, -- optional secondary KPI
  commission_pct  numeric(5,2) NOT NULL DEFAULT 0,    -- % of net sales
  commission_bonus numeric(14,2) NOT NULL DEFAULT 0,  -- flat bonus on hitting 100%
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rep_id, period)
);
```

Keep `reps.daily_quota_fils` as a *daily* soft goal (mobile only); monthly targets live here.
Commission scheme v1 = linear `% of net sales` (+ flat bonus at 100%). Tiered schemes are a
v2 (`commission_tiers` jsonb) — leave room, don't build.

## 4. API

| Method & path | Who | Purpose |
|---|---|---|
| `GET /reps/:id/targets?period=YYYY-MM` | manager+ | One row (or empty) |
| `PUT /reps/:id/targets/:period` | manager+ | Upsert `{ salesTarget, collectionTarget, commissionPct, commissionBonus }` |
| `GET /reps/:id/commission?period=YYYY-MM` | manager+ or the rep himself | Computed: `{ netSales, returns, attainmentPct, commissionEarned, bonusEarned }` |
| `GET /reports/rep-leaderboard` (extend) | any | add `salesTarget`, `attainmentPct` per row when a target exists for the period |

**Computation** (in `ReportsService`, same SQL style as `repLeaderboard`):
`netSales = Σ posted SALE net_total − Σ posted RETURN net_total` for the rep's `user_code`
within the period; `attainment = netSales / sales_target`;
`commission = netSales × commission_pct/100 (+ bonus if attainment ≥ 1)`.
Returns subtract — that's deliberate (stops "sell big, return later" gaming).

Mobile needs it too: extend `GET /reps/me/kpis` with
`{ monthTarget, monthNet, attainmentPct, commissionEarned }`.

## 5. Dashboard UI

- **Rep drawer** (`/reps`): "الأهداف والعمولة" card — period picker (month), target JOD,
  commission % + bonus, save. `<Can role="manager">`.
- **Leaderboard** (dashboard home + reports): add attainment column — small progress bar +
  mono `82%`; rank by attainment when targets exist, fallback to net sales.
- **Month-end export**: button on reps page → CSV `rep, code, target, net, attainment, commission`.
- i18n prefix `target.*` (ar/en).

## 6. Mobile UI (FlowVan)

- **Home**: replace the static KPI tile row's 4th tile with a **target ring**
  (Canvas arc, green→amber by attainment) + "هدف الشهر 5,000 · حققت 3,400".
- **Commission card** under it: "عمولتك حتى الآن 45.200 JOD" (mono), tap → simple
  breakdown sheet (net sales × % + bonus state).
- Data: from extended `/reps/me/kpis`, cached in Room for offline display.
- Optional dopamine: confetti animation the first time attainment crosses 100% in a period
  (local flag).

## 7. Acceptance criteria

1. Upsert target → leaderboard shows attainment for that period within one refetch.
2. Commission math: net 3,400 / target 5,000 / 2% / bonus 50 → attainment 68%,
   commission 68.000, bonus 0. At net 5,100 → bonus included.
3. RETURN vouchers reduce net (verified by posting a return and watching attainment drop).
4. Rep without a target row: mobile ring hidden, leaderboard falls back gracefully.
5. The rep can read **only his own** commission endpoint (403 on others).

## 8. Test plan

Unit: commission calculator edge cases (zero target, returns > sales, bonus boundary).
E2E: PUT target → seed sales → GET commission. FE: drawer save round-trip.
