# PLAN — ERP ⇄ VanFlow quantity & transfer sync: diagnosis and a durable fix

Status: **diagnosis complete, proposal for decision.** Not yet implemented. Touches
live production sync on both clients (94.142.51.91, 77.245.5.113) and requires
changes in BOTH repos (`cash-van-dashboard` and `ERP`).

---

## 1. Root cause, in one sentence

**Cash-van has no stored stock quantity at all — it is a running SUM of movement
deltas mirrored from the ERP through a lossy feed, with no absolute
reconciliation — so every dropped, duplicated, or double-counted movement drifts
the quantity permanently and nothing ever corrects it.**

`item_balance` is a **VIEW** that sums signed `voucher_transactions`
(`1722600000000-PerUnitStock.ts:71-102`). Every ERP movement becomes a posted
`ERP-MV-<id>` voucher (`erp-sync.service.ts:1469-1550`). On-hand = the sum of
every delta ever applied. There is no baseline and no truth-up.

## 2. The ERP is already the source of truth — and already exposes it

The ERP writes authoritative on-hand atomically to `item_stock` per
(sku, warehouse) via one path (`ERP/src/lib/stock-movement.ts`), and **already
serves an absolute snapshot**: `GET /api/v1/van/stock` returns live
`quantity / reserved / available` per warehouse. Cash-van does not use it for
correctness — it drives quantity off the *delta* feed instead, and the two are
never reconciled (no shared watermark).

## 3. Why the obvious fix ("just reconcile against the snapshot") is not enough

**It was already built and removed.** `1721500000000-ErpStockSnapshot` added
`/van/stock` net-delta reconciliation; `1721600000000-DropErpStockSnapshot`
dropped it, for two documented reasons:

1. **Repeated double-counting / opening-balance bugs** — the reconciliation
   applied correction *deltas* into the same voucher ledger that the feed was
   also filling, so a movement got counted twice (once as the correction, once
   when the feed carried it).
2. **API-key rate-limit exhaustion** — it probed the ERP per store, too often.

Any new reconciliation MUST structurally prevent both, or it will be removed
again. That constraint shapes the whole design below.

## 4. Concrete failure modes, ranked by how much they drift quantities

Each is confirmed in code by the three-way investigation (cash-van outbound,
cash-van inbound, ERP side).

| # | Failure | Evidence | Effect |
|---|---|---|---|
| A | **Skip-on-error advances the cursor past lost movements.** A movement whose SKU isn't in `item_cart` yet is logged and skipped, but `maxTs` still advances and the cursor saves — never retried even after the catalogue syncs. | `erp-sync.service.ts:1371-1393` | Permanent under/over-stock, silent |
| B | **Timestamp-tie boundary loss.** Cursor is a `createdAt` high-water mark; the feed filters strictly `>`. Same-second movements (a transfer's two legs, a multi-line doc) straddling a run boundary are never re-fetched. No id tiebreaker on either side. | `erp-sync.service.ts:1391`, ERP `stock-movements/route.ts:72,88`; `createdAt` is nullable & unindexed `schema.ts:416-421` | Silent dropped deltas |
| C | **Echo-loop guard is a leaky string.** The feed excludes `source='van'`, set by only 3 ERP routes. Transfers/payments use a *different* literal (`van_sales_api`); ERP-dispatched transfers write `source`-null. Those echo back and **double-count**. | ERP `stock-movements/route.ts:71` vs `stock-transfers/route.ts:311`, `payments/route.ts:272` | Transfer/qty double-count |
| D | **Edited-and-reposted vouchers never re-sync.** Outbox dedups `(kind, ref)` and refuses to re-queue a `posted` row; an edited voucher keeps the ERP's original quantities forever. | `erp-outbox.service.ts:83` | ERP holds stale quantities |
| E | **Full-store probing every 5 min → rate-limit pressure** (the same failure that killed the snapshot). One+ call per warehouse *and* per rep code, each cycle, incl. stale codes. | `erp-sync.service.ts:1308-1337` | Feed times out → feeds A/B |
| F | **No reconciliation pass exists.** The spec calls for a nightly drift job (`erp_sync_runs`); it was never built. | `docs/ERP-MIRROR-SYNC.md:105-108` (absent in code) | Drift is never corrected |
| G | **Silent rounding on transfers/adjustments/requests.** `Math.round()` with no positivity/integer check — the opposite of the strict `erpQty()` used for sales. <0.5 rounds to 0. | `erp-outbox.service.ts:406-408,818,846` | Small permanent divergences |
| H | **Outbox concurrency gaps.** No DB uniqueness on `(kind, ref)`; in-process-only drain lock; no `FOR UPDATE SKIP LOCKED`. Masked today only by the ERP idempotency key. | `erp-outbox.service.ts:82-87,121-164`; migration `1719100000000` (non-unique) | Duplicate pushes if key path ever fails |
| I | **Delivery is a payload-free nudge.** Both directions use a content-free ping with no retry/persistence; recovery depends on the 5-min poll, which re-exposes A/B. | `ERP/src/lib/vanflow-notify.ts`, cash-van `controller.ts:50-57` | Missed change waits on poll |

A/B/C/F are the ones that produce the quantity and transfer drift you're seeing.
The others compound it.

## 5. The fix: an absolute baseline anchored to a movement sequence

The design principle that makes it correct *and* avoids the two reasons the last
attempt was removed: **a movement is applied exactly once — it is either inside a
snapshot (seq ≤ watermark) or in the feed (seq > watermark), never both — and
reconciliation REPLACES the baseline rather than adding correction deltas.**

### 5.1 ERP side (source of truth) — required changes

1. **Monotonic sequence on movements.** Add/confirm a `bigserial seq` on
   `stock_movements`; the `/stock-movements` feed orders and cursors on `seq`,
   not `createdAt`. Kills tie/skip losses (B) by construction.
2. **Snapshot returns a watermark.** `GET /van/stock` returns, alongside
   quantities, the current `maxSeq` per warehouse (the seq the snapshot is
   consistent with). This is the missing link that lets a snapshot and the feed
   align with zero overlap.
3. **Echo exclusion keyed to the integration identity, not a string.** Exclude
   feed rows written by the integration API user/key, so no write path can leak
   (fixes C permanently). Retire the `source='van'` literal match.

### 5.2 Cash-van side — required changes

1. **A real `stock_snapshot` table** (absolute qty per store/item/unit, plus the
   ERP `seq` it was taken at). Live on-hand = latest snapshot **+** movements
   with `seq > snapshot.seq`. The `item_balance` view becomes
   `snapshot + bounded delta` instead of `sum of all history`.
2. **Seq-based feed cursor** (`sinceSeq`), replacing the timestamp watermark.
3. **A retry queue for un-mirrorable movements** (SKU not yet in catalogue):
   dead-letter with the seq, retried after the next catalogue sync — the cursor
   never advances past an unapplied movement (fixes A).
4. **Nightly reconciliation = re-snapshot.** One bulk paginated `/van/stock`
   call for the van stores + main warehouse (not per-store every cycle),
   writing a fresh `stock_snapshot` at the returned watermark and resuming the
   feed strictly after it. Because it replaces the baseline and the feed resumes
   at the watermark, **no movement is double-counted** (fixes the reason the old
   snapshot was removed) and **rate-limit pressure drops** (one nightly bulk call
   vs. per-store every 5 min — fixes E and the second removal reason).
5. **Outbox hardening** (independent, ship anytime): unique `(kind, ref)`,
   `FOR UPDATE SKIP LOCKED` drain, a content hash on `ref` so an edited voucher
   re-queues (fixes D, H); strict integer/positive validation on transfer &
   adjustment quantities (fixes G).

The payload-free nudge (I) can stay — with a lossless seq feed and nightly
reconciliation, it is just a "poll sooner" hint and correctness no longer
depends on it.

## 6. Rollout — this is live production on two clients

- Every ERP-side change (seq, watermark, identity-based exclusion) ships in the
  **ERP** repo and must land and deploy **before** cash-van starts relying on it.
- The cash-van baseline model is a migration that changes how `item_balance`
  computes — it must be introduced additively (new snapshot table + a first
  reconciliation to seed the baseline) with the old view kept until the new path
  is proven, then switched.
- Both clients' current quantities are already drifted; the first reconciliation
  will **correct them to the ERP truth**, which is the goal but will visibly move
  numbers — so it needs a heads-up and a quiet window.

## 7. Recommended first step (safe, high-value, decision-informing)

**Build a read-only drift detector before changing any write path.** A job that
pulls the `/van/stock` snapshot and compares it to cash-van's computed on-hand,
reporting divergence per (store, item) on the dashboard. It:

- **Proves and quantifies** the problem you're describing — turns "quantities
  are off" into a list of exactly which items, which stores, by how much.
- Is **completely read-only** — zero risk to live data.
- **Validates `/van/stock` and the nightly rate-limit behaviour** before we
  commit to writing against it — the exact thing that sank the last attempt.
- Ships an immediate operational win (a "these disagree" report) regardless of
  whether we proceed to the full redesign.

Once the detector shows the shape and size of the drift, we roll out §5 in order:
ERP seq+watermark+identity-exclusion → cash-van seq cursor + retry queue →
baseline snapshot + nightly reconciliation → outbox hardening.
