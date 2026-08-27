# Human test — last 4 features (this session)

Manual QA for the four features delivered this session. Do the sections in
order; section 1 sets up the data the others rely on.

Legend: **App** = the salesman phone app (FlowVan). **Dashboard** = the office
web dashboard. **ERP** = the accounting system.

The four features under test:
1. **Orders come from the main store** — an order is a voucher request drawn from
   a central depot, not the van; a *credit* salesman (no van) can order too.
2. **Per-van item allowlist** — a salesman only sees/handles items his van store
   is linked to in the ERP (sale, request, return, order, reports).
3. **Live ERP on-hand quantities** — dashboard and app read stock straight from
   the ERP (the book of record), not the summed-delta view.
4. **Socket live refresh** — a stock change (transfer/sale/ERP move) reflects on
   the dashboard and app in real time, no manual reload.

---

## Preconditions

- The **new build** is running everywhere — backend, dashboard, and app on the
  current `dev` images, and the backend **migrations have run** (the
  `main_store_number` column must exist on `app_settings`).
- **ERP integration ON** and connected (Dashboard → Settings → ERP shows
  *connected*), so live-stock reads work.
- In the ERP, at least one **depot** (non-van store) holds stock for a few items;
  note one item + its main-store quantity **N** before you start.
- A **van salesman** account: has a van store assigned, and that van store is
  **linked to a subset of items** in the ERP (so the allowlist has something to
  filter).
- A **credit salesman** account: has **no van store**, only a salesman account.
- An **admin** account for Settings.

---

## 1. Orders come from the main store (+ credit salesman)

### 1a. Pick the main store (Dashboard, as admin)
1. Dashboard → **Settings → Company**.
2. Find **"Main store for orders" (المستودع الرئيسي للطلبات)**. The dropdown lists
   only **depots** (no van stores).
3. Select the depot that holds item quantity **N**. **Save**.
   - ✅ Reopening Settings shows the same store still selected.
4. (Fallback check) Set it back to **"System default (ERP main depot)"** and Save.
   - ✅ Accepted; orders then fall back to the ERP's default depot.
   Re-select your chosen depot before continuing.

### 1b. Order quantity comes from the main store (App, as the VAN salesman)
1. App → **Order / طلب** flow. Open an item that the main store stocks.
   - ✅ The available quantity shown equals the **main store's** quantity **N** —
     **not** the salesman's van count. (If the van holds a different amount, the
     order screen still shows the main-store number.)
2. Compare with the **Sale / بيع** flow for the same item.
   - ✅ Sale shows the **van's** quantity (may be 0 or different) — proving order
     and sale read different stores.

### 1c. A credit salesman (no van) can still order (App, as the CREDIT salesman)
1. Log in as the credit salesman. Open the **Order** flow.
   - ✅ Ordering works — items and main-store quantities appear even though this
     salesman has **no van store**.
2. Open the **Sale** flow.
   - ✅ Either unavailable or empty — a credit salesman with no van has no van
     stock to sell (expected; only ordering is offered).

**Expected:** orders always read the configured main store; a credit salesman
can order; sale/order clearly read different stores.

---

## 2. Per-van item allowlist

*Setup:* in the ERP, confirm the van salesman's **van store is linked to only
some items** (e.g. items A and B), and NOT linked to item C.

**App, as the van salesman:**
1. Open the **item list** (for sale/request/return/order pickers).
   - ✅ Items **A and B appear**; item **C does not**.
2. Try to search for item **C** by name/barcode.
   - ✅ It is not offered — the van cannot sell/return/order an item its store
     doesn't carry.
3. Open **item reports** on the app.
   - ✅ Only the van's allowed items are listed.

**Dashboard / BE cross-check:**
4. Dashboard → **Items**, filtered by that salesman's van (or hit the products
   list as that salesman).
   - ✅ Same allowlist applies — the list is limited to the van store's items.

*Edge:* a salesman with **no van** (or a van linked to nothing) is **not**
filtered — they see the full catalog (no restriction), which is the intended
fallback so ordering still works.

**Expected:** each van only sees the items its store is linked to; the credit /
no-van salesman is unrestricted.

---

## 3. Live ERP on-hand quantities

**Prove the number comes from the ERP, live:**
1. Note item **X**'s on-hand for a **depot** on the Dashboard (Items → balance,
   or the ERP-stock view).
2. In the **ERP**, post a movement that changes item **X** in that depot
   (a stock-in, or a transfer). Note the new ERP quantity **X'**.
3. Back on the **Dashboard**, re-open the item's balance / ERP-stock.
   - ✅ It shows **X'** (the new ERP number) — not the old value, and without
     waiting for a cash-van voucher to sync.
4. App → **itemBalance** for item **X** in that depot.
   - ✅ Shows **X'** for the depot.
   - ✅ For a **van** store, the app shows the **van's local** count (deliberately
     — the local ledger drops the instant the salesman sells; the ERP lags his
     un-synced sales, so van stock stays local to prevent overselling).

*Resilience:* stop/disconnect the ERP briefly and reload.
   - ✅ Views still render using the **local** quantity — no blank/zeroed screen,
     no crash. Reconnect and the live number returns.

**Expected:** depot quantities are the ERP's live number; van quantities stay
local; an ERP outage falls back to local instead of breaking.

---

## 4. Socket live refresh

*Two screens side by side:* keep the **Dashboard** open on a stock view (item
balances / a van's materials) while you cause a change elsewhere.

1. Cause a stock change that hits the ERP/backend — e.g.
   **approve+post a transfer**, record a **sale**, or post a **movement in the
   ERP** that the backend pulls.
2. Watch the open Dashboard **without reloading**.
   - ✅ The affected quantities **update on their own** within a few seconds
     (the `sync.required` / `stock.changed` socket event fires and the
     item-balances / materials-by-warehouse / erp-item-stock views refresh).
3. On the **App**, open the same item after the change.
   - ✅ It reflects the latest quantity (pull-to-refresh at most; no stale cache).

**Expected:** stock views stay live — a transfer/sale/ERP move reflects on the
dashboard in real time with no manual reload.

---

## Quick pass/fail summary

| # | Feature | Pass when… |
|---|---------|-----------|
| 1 | Orders from main store | Order qty = main-store N (not van); credit salesman can order; setting persists |
| 2 | Per-van allowlist | Van sees only its store's items everywhere; no-van salesman unrestricted |
| 3 | Live ERP qty | Depot shows live ERP number; van stays local; ERP outage falls back, no crash |
| 4 | Socket live refresh | Dashboard/app update on a stock change with no manual reload |
