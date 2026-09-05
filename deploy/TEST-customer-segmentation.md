# Test plan — Customer Segmentation (phases 1–4)

Verified end-to-end on 2026-09-04 against the local stack (API `:3100`, dashboard
`:3002`, DB `flowvan`, 17 customers / 1 offer). Every phase below passed the API
smoke test; the steps let you re-verify in the dashboard UI.

## Prerequisites
- Backend running with the four migrations applied (`customer_segments`,
  `segment_customers`, `segment_reps` tables exist).
- Sign in as **admin / admin1234** (Segments write actions are admin-only;
  managers can read).
- Open **Operations → Segments** in the sidebar.

---

## Phase 1 — the primitive (static segments)

| # | Step | Expected |
|---|------|----------|
| 1.1 | Click **New segment**, enter a name (ar + en), pick a colour, leave type = **Manual**, Save | Card appears with the colour dot, member count **0** |
| 1.2 | Open the segment → **Add customers** → search a customer → **Add** | Toast/row confirms; member count increments; row shows the customer |
| 1.3 | Remove a member (trash icon) → confirm | Member disappears; count drops |
| 1.4 | Open any customer's profile (Accounts → a customer) | The segment shows as a **chip** under the salesman line |
| 1.5 | Sign in as a **manager** scoped to certain reps | The members list shows only that manager's own customers |

**API check:** `POST /segments`, `POST /segments/:id/members {customerNumbers:[…]}`,
`GET /segments` → `memberCount` reflects the adds. ✓ verified (added 3, source=MANUAL).

---

## Phase 2 — target an offer at a segment

| # | Step | Expected |
|---|------|----------|
| 2.1 | Offers → New offer → set **Customer scope = Segment** | A **segment multi-select** appears (not the old comma-box) |
| 2.2 | Pick one or more segments, finish and save the offer | Saves (HTTP 201); the offer stores `eligibility.segmentIds` |
| 2.3 | Evaluate the offer for a customer **in** the segment (make a cart / call `/offers/evaluate`) | The discount **applies** |
| 2.4 | Evaluate for a customer **not** in the segment | The discount **does not apply** |
| 2.5 | Create a "Segment" offer but pick **no** segment | It matches **nobody** (regression guard), never everybody |

**Offline note:** on the mobile app, segment members are pre-expanded into the
offer at `/offers/active`, so the discount also applies offline once the app syncs.
**API check:** offer with `eligibility.segmentIds` → HTTP 201. ✓ verified.

---

## Phase 3 — dynamic (rule-driven) segments

| # | Step | Expected |
|---|------|----------|
| 3.1 | New segment → type = **Dynamic** → rule builder appears | Match ALL/ANY + condition rows |
| 3.2 | Add a rule, e.g. **Customer type · is · CASH**, Save | Segment is materialised immediately; member count = matching customers |
| 3.3 | Open it → **Refresh** | Toast "Refreshed — N customers"; count stable on repeat |
| 3.4 | Add a rule with a **bad value** (e.g. Created date · before · `2024-13-99`) | Save is **rejected (400)** with a clear message — not saved empty |
| 3.5 | Pick a **boolean** field (Credit hold) and Save without touching the value | Saves fine (defaults to "No") — no 400 |
| 3.6 | Manually **add** a customer to a dynamic segment, then edit that customer so the rule no longer matches, then Refresh | The manually-added customer **stays** (manual adds survive a refresh) |
| 3.7 | Change a customer's data that matches a rule | Within ~5 s the dynamic segment auto-refreshes (debounced) |

**API check:** dynamic rule `customerType eq CASH` auto-matched **14** members on
create; bad-date rule → 400. ✓ verified.

---

## Phase 4 — analytics + rep linking

| # | Step | Expected |
|---|------|----------|
| 4.1 | Open a segment → **Performance** tab, set a date range | Tiles: **Net sales, Orders, Avg order, Active/Members**; **Top items** and **By salesman** tables |
| 4.2 | Confirm money reads as JOD (e.g. `278.500`), not off by 1000× | Uses JOD-major formatting |
| 4.3 | As a scoped **manager**, open Performance | Only that manager's own members' sales are counted |
| 4.4 | **Salesmen** tab → link a salesman | Appears in the linked list; unlink removes it |
| 4.5 | **Salesmen** tab → **Assign all** → pick a rep → confirm | Toast "Assigned N customers"; every member's salesman is now that rep (check a couple of customer profiles) |
| 4.6 | Re-open Performance | Numbers recompute for the range |

**API check:** `GET /segments/:id/stats?from&to` →
`salesNet=278.5, orders=5, aov=55.7, topItems=9, byRep=1` over real vouchers. ✓ verified.

---

## What to watch for (edge cases already covered)
- A **Segment**-scope offer with no segment selected matches **nobody** (not everybody).
- A **manual** member is never removed by a rule refresh.
- Dynamic rules only touch **RULE**-sourced membership; over-cap segments keep a
  stable (ordered) member set.
- All money is **net_total** JOD-major; the per-rep breakdown counts only sales
  rung by a live rep, so it may not foot exactly to the headline (by design).
