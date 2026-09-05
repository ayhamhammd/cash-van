# Human test — inventory flow (this task)

Manual QA for the five items delivered this session. Do them in order: 1 → 2
build the data that 3 → 5 verify.

Legend: **App** = the salesman phone app (FlowVan). **Dashboard** = the office
web dashboard. **ERP** = the accounting system.

---

## Preconditions

- The **new build** is running everywhere. None of this is on the old images —
  the backend, dashboard, and app must be the current `dev`/`requirement-ferdous`
  build, and the backend migrations must have run.
- A salesman account with a **van store** assigned and the **"request stock"**
  permission on (Dashboard → Reps → the salesman → permissions).
- A manager/admin account with **"decide stock requests"** permission.
- The **main warehouse (المستودع الرئيسي / MAIN)** has stock for a few items —
  note one item and its quantity before you start.

---

## 2. Requisition from the main warehouse, with quantity shown and capped
*(do this before 1 — it creates the request 1 receives)*

**App, as the salesman:**
1. Open the app → **طلب بضاعة من الكاش فان** (request stock).
2. Tap an item that the main warehouse stocks. In the quantity sheet, confirm
   the line reads **"بالمستودع N"** next to the on-van count — N is the main
   warehouse's current quantity for that item.
3. Type a quantity **greater than N**.
   - ✅ The button reads **"يتجاوز المتوفر"** and is **disabled** — you cannot add it.
   - ✅ The availability line turns **red**.
4. Lower the quantity to **≤ N**, add to cart, add one or two more items, and
   **send the request**.
   - ✅ The request is created and appears under "my requests" as **pending**.
5. (Backstop) If you managed to send an over-quantity by any path, the server
   rejects it: a message **"الكمية المطلوبة تتجاوز رصيد المستودع الرئيسي…"**.

**Expected:** the salesman can see how much the main warehouse holds, and can
never request more than that.

---

## 5. Verify and transfer between the salesman and the warehouse
*(the manager approves the request from 2)*

**Dashboard, as the manager:**
1. Open **طلبات البضاعة** (stock requests). Open the pending request from step 2.
2. Choose a **source store (المصدر)**. A new **"بالمستودع / At source"** column
   appears, showing that depot's live stock per line.
3. In a line's grant box, type a quantity **greater than** its "At source" value.
   - ✅ The "At source" cell turns **red** and the **Approve button is disabled**.
   - ✅ If you force it, the server rejects: **"الكمية الممنوحة تتجاوز رصيد المستودع…"**.
4. Set every grant **≤ its "At source"** value (grant the full asked amount, or less).
5. Press **Approve (موافقة)**.
   - ✅ The request becomes **approved** and the screen goes to the transfer,
     prefilled with the same items and quantities.
6. Post/confirm the transfer (or leave it for the salesman to receive in test 1).

**Expected:** the manager sees depot availability while deciding, cannot grant
more than the depot has, and approval carries straight into a matching transfer.

---

## 1. Confirm inventory receipt from the delivery person

**App, as the salesman** (after the manager approved in test 5, and if the
office did NOT already post the transfer):
1. Open the app → the approved request under "my requests".
2. Note the van stock for one of the items now (Van stock screen).
3. Press **استلام / تأكيد الاستلام** (receive) on the approved request.
   - ✅ The request status becomes **received**.
   - ✅ The item's **van stock increases** by the approved quantity.
   - ✅ The main/source warehouse's stock **decreases** by the same amount
     (check on the Dashboard stock balances or the ERP).
4. Confirm the stock only moved **once** — receiving is what raises the transfer;
   it is not double-counted if the office also looked at it.

**Expected:** confirming receipt is what actually moves the goods onto the van,
exactly once, and both sides' quantities reflect it.

---

## 4. Search for items and customer segments

Test the new **all-words, any-order, partial-match** search. Pick a customer or
item whose name has **two or more words**.

**Dashboard:**
1. **Customers** page search: type the name's words **in reverse order** (e.g.
   for "منظفات عمان" type "عمان منظفات").
   - ✅ The record is found — order does not matter.
2. Type a **partial piece of each word** (e.g. "منظ عم").
   - ✅ Still found.
3. Type one real word plus a word that is **not** in the name.
   - ✅ **No result** — every word must match (it narrows, not widens).
4. Repeat on the **Products** page (item name / SKU) and **Reps**.

**App:** repeat the same three checks in the customer list search and in a
sale/return/stock-request **item** search.

**Expected:** every search box — dashboard and app — finds a record when all the
typed words appear anywhere in it, in any order, as partial matches; a word that
isn't there removes the record from the results.

---

## 3. Synchronization (reduced time + drift visibility)

Two things to observe.

**A — the change reflects quickly.** Make a stock movement in the **ERP** (e.g.
a receipt or adjustment on an item, or the transfer from test 5).
1. Watch the Dashboard / app stock for that item.
   - ✅ It updates within a short delay (the ERP nudges the hub to pull; it no
     longer waits only on the slow periodic poll).

**B — drift check (read-only).** On the Dashboard, open the **ERP ops** page
(تصدير ERP / ERP export).
1. Find the **"فحص فروقات المخزون / Stock drift check"** card.
2. Press **افحص الآن / Check now**.
   - ✅ It returns a summary — **drifted items, total drift, items compared** —
     and a table of any (store, item) where the ERP quantity and the app's
     quantity disagree, with both numbers and the difference.
   - ✅ If the two systems agree, it shows **"no drift — quantities match"**.
3. This check **changes nothing** — it only reports. Run it before and after the
   moves above to see the numbers line up.

**Expected:** ERP changes reach the hub promptly, and the drift check gives a
precise, read-only list of any quantity that is out of step — no guessing.

---

## Notes for the tester

- If a stock number looks wrong anywhere, run the **drift check** (test 3B)
  first — it tells you whether the ERP and the app actually disagree, and on
  which item, before anyone chases a phantom.
- Quantities on stock requests are in **base pieces**. An item requested by
  carton shows its piece total once converted.
- The deeper sync rework (an automatic nightly reconciliation that *corrects*
  drift) is not in this build yet — test 3 verifies detection and faster
  delivery, not automatic correction.
