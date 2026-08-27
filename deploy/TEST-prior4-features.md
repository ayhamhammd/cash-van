# Human test — the 4 features before the last batch

Manual QA for the four features that shipped **just before** the main-store /
allowlist / live-qty / socket batch. Each is independent — do them in any order.

Legend: **App** = the salesman phone app (FlowVan). **Dashboard** = the office
web dashboard. **ERP** = the accounting system.

The four features under test:
1. **Live customer & rep credit from the ERP** — customer balance + credit limit,
   the customer statement, and the salesman's own account balance, read live
   from the ERP (the book of record) instead of recomputed locally.
2. **Stock drift detector** — a read-only report comparing the ERP's stock
   snapshot against cash-van's computed on-hand, per store/item.
3. **A rep's materials grouped by warehouse** — list the items a salesman's van
   carries and how much every warehouse holds of each.
4. **Token-based search** — every dashboard search box matches each word
   separately, so word order and gaps don't matter ("abu market" finds
   "Abu Rayash Market").

---

## Preconditions

- The **new build** is running everywhere (backend, dashboard, app on current
  `dev`), migrations run.
- **ERP integration ON** and connected (Dashboard → Settings → ERP shows
  *connected*) — features 1–3 read live ERP data.
- At least one **customer linked to the ERP** (has a customer number) with some
  invoice/receipt history, and one **salesman linked** via his ERP account code
  (`reps.erp_account_code`). Also keep one **unlinked** customer/rep to test the
  graceful-gap path.

---

## 1. Live customer & rep credit from the ERP

### 1a. Customer balance + credit limit (Dashboard)
1. Dashboard → **Customers** → open a **linked** customer's profile.
2. Find **"Balance (ERP) / الرصيد (ERP)"** and **"Credit limit / سقف الائتمان"**.
   - ✅ A real figure shows, labelled as coming from the ERP.
3. In the **ERP**, open the same customer and compare the balance.
   - ✅ The two match (e.g. the verified case: `CUST-000001` balance ≈ **-6.026**).
4. Open an **unlinked** customer's profile.
   - ✅ It shows **"Unavailable / غير متوفر"** (not a wrong 0, not a crash) —
     the reason is *unlinked*.

### 1b. Customer statement (Dashboard)
1. On the linked customer, open **"Statement (ERP) / كشف الحساب (ERP)"**.
   - ✅ A running statement lists invoices + receipts with a running balance,
     the way the ERP renders it.
2. Compare the statement's closing balance with the balance from 1a.
   - ✅ They reconcile (same figure).

### 1c. Salesman account balance (Dashboard)
1. Dashboard → **Reps / Salesmen** → open a **linked** salesman.
2. Find **"Balance (ERP) / الرصيد (ERP)"** with the hint *"the 'cash with
   salesman' account, live from the ERP"*.
   - ✅ Shows the salesman's GL account balance, live.
3. Open an **unlinked** salesman.
   - ✅ **"Unavailable"** — degrades cleanly.

**Expected:** balances/statement come straight from the ERP; an unlinked or
offline case says so instead of showing a misleading number.

---

## 2. Stock drift detector

**Dashboard, as admin:**
1. Dashboard → **ERP Export** → the **"Stock drift check / فحص فروقات المخزون"**
   section. Press **"Check now / افحص الآن"**.
2. Wait for the read-only comparison to finish.
   - ✅ You get summary tiles: **Drifted pools**, **Total drift**, **Pools
     compared**, **Unresolved SKUs**, **Unmatched warehouses**.
   - ✅ A table lists each divergence: **Store · Item · ERP · Cash-van · Delta**.
   - ✅ If nothing differs: **"No drift — quantities match."**
3. Confirm it **changed nothing** — re-open item balances; quantities are
   untouched (this report only reads).
4. (Negative) Temporarily point the ERP config at a bad URL / disconnect and
   press Check.
   - ✅ A clear **503 "ERP unavailable"** style message — not a raw 500 or a
     blank screen.

**Expected:** the report quantifies stock drift per store/item, writes nothing,
and fails loudly-but-cleanly when the ERP is unreachable.

---

## 3. A rep's materials grouped by warehouse

### 3a. Dashboard (office)
1. Dashboard → **Reports** → the **materials** section. Pick a salesman who has a
   **van store with stock** (e.g. the verified rep on van store **103**).
   - ✅ The salesman's materials list — **the rep's van group leads** ("Rep's
     van / مركبة المندوب"), then the other warehouses.
   - ✅ Each material shows the quantity **every warehouse** holds of it
     (e.g. the same items' holdings in **MAIN**).
2. Pick a salesman with **no van / no materials**.
   - ✅ **"This salesman has no materials."** (empty, no crash).

### 3b. App (the salesman)
1. Log in as that salesman; open **his materials** screen.
   - ✅ Same list — the van's items and where each is stocked. Pure visibility;
     nothing is blocked or restricted here.

**Expected:** a salesman (and the office) can see the van's materials and every
warehouse's quantity of each, van first.

---

## 4. Token-based search

Try these in **any** dashboard search box (Customers, Products, Reps, Offers,
Regions). Arabic example uses a customer named **"منظفات عمان"**.

1. Search the two words **in reverse order**: `عمان منظفات`.
   - ✅ Finds **"منظفات عمان"** — word order doesn't matter.
2. Search **partials of each word**: `منظ عم`.
   - ✅ Still finds it — each token is a substring match.
3. Search with **one word that isn't there**: `منظفات دبي`.
   - ✅ Returns **nothing** — every token must match (AND, so more words narrow).
4. English equivalent: for a customer "Abu Rayash Market", search `abu market`.
   - ✅ Finds it, though the words aren't adjacent.
5. Repeat one of the above on **Products** and **Reps**.
   - ✅ Same behaviour — the strategy is shared across the list endpoints.

**Expected:** search finds records by any words in any order; adding a word that
doesn't match removes the record rather than loosening the search.

---

## Quick pass/fail summary

| # | Feature | Pass when… |
|---|---------|-----------|
| 1 | Live customer/rep credit | Balance/statement match the ERP; unlinked shows "Unavailable", never a wrong 0 |
| 2 | Stock drift detector | Per-store/item drift table + tiles; writes nothing; clean 503 when ERP is down |
| 3 | Rep materials by warehouse | Van group leads; every warehouse's qty per item; empty for a no-van rep |
| 4 | Token search | Words in any order/partial match; a missing word returns nothing; works on all lists |
