# Manual test — van stock requests

Written against **your machine as it stands now**, so the expected values are the
real ones, not examples. Roughly 20 minutes end to end.

Tick each **Expect**. Anything that does not match is a bug — note the test
number.

## Before you start

| | |
|---|---|
| ERP | http://localhost:3000 |
| Dashboard | http://localhost:3001 |
| API (phone) | `http://192.168.1.164:3100` |
| Dashboard login | `admin` / `admin1234` |

Phone: install the current build, and make sure it points at the LAN address
above — not `localhost`, which on the phone means the phone.

```bash
cd /Users/jehadalomour/7Software/FlowVan && ./gradlew :composeApp:installDebug
```

Two requests are already approved and waiting. They are set up to test opposite
things, so **do not delete them** before tests 4 and 5:

- **SR-000011** — 3 lines, everything in stock. The one that should transfer.
- **SR-000005** — 3 lines, one of which the warehouse cannot fill. The one that
  should be refused.

---

## 1 · The phone builds a request like a sale

**Do**

1. Home → **طلب بضاعة**.
2. Search an item, tap it. Set the quantity with `+`/`−`, then type a number
   directly over it.
3. Open the unit dropdown. Pick a pack unit (كرتونة / صندوق) if the item has one.
4. **إضافة للسلة**.
5. Add two more items — for one of them pick a **colour** (أحمر / أخضر …).
6. Tap the cart badge **السلة (3)**.
7. Type a note, then **إرسال الطلب**.

**Expect**

- The sheet shows `= N حبة` under the quantity **only** when the unit converts —
  never for a plain piece.
- The cart card shows `= N حبة` and `× qty`, and **no prices anywhere**. A price
  or a `0.000` on this screen is a bug.
- Three separate lines. An item added twice under two different units stays two
  lines; added twice under the *same* unit it stays one.
- After sending: cart empties, you land back on the item list, and the new
  request appears under **طلباتي** as `قيد الانتظار`.

**Also try:** press the phone's back button while in the cart. It should return
to the item list, **not** leave the screen and lose the cart.

---

## 2 · The office hears it arrive

Have the dashboard open at **طلبات البضاعة** on another screen *before* you send
the request in test 1.

**Expect**

- The request appears **without refreshing**, within a second or two.
- A short two-note chime plays. (Click anywhere on the page once beforehand —
  browsers block sound until the page has been interacted with.)
- The count badge next to the page title goes up.

---

## 3 · Partial approval

**Do**

1. Open the pending request from test 1.
2. Read the lines: **المطلوب** is what the rep asked for, **على المركبة** is what
   they already had.
3. In **الممنوح**, reduce one line — say 12 down to 8. Leave the others alone.
4. Pick **المستودع المصدر** = `المستودع الرئيسي (MAIN)`.
5. Add a note and **موافقة**.

**Expect**

- Only depots in the source list. **No vans** — a van never loads another van.
- Typing a granted figure *higher* than requested is refused.
- Zeroing **every** line is refused, and tells you to reject instead.
- The reduced line shows `8 من 12` in amber on the phone under **طلباتي**; the
  untouched lines show a single number.
- The phone's status changes to **بانتظار الاستلام** without you touching it.

---

## 4 · Approve, then make the transfer  ← the main one

**Do**

1. Open **SR-000011** (tab **تمت الموافقة**).
2. Press **إنشاء التحويل**.

**Expect on the transfer page**

| field | value |
|---|---|
| من | `المستودع الرئيسي` |
| إلى | `جهاد مندب` (van 101) |
| lines | **3** / **1** / **4** |

Those quantities are the point. They are in the **rep's own units**, not pool
pieces. If you see the pool figures instead, that is the conversion bug — say so.

3. Press **تحويل وترحيل**.

**Expect**

- A receipt appears with a voucher number `TRF-…`.
- Back on **طلبات البضاعة**, SR-000011 has moved to **تم الاستلام** and shows
  that voucher number.
- On the phone, pull **تحديث** under طلباتي: the request now reads
  **تم الاستلام** and the **استلمت البضاعة** button is **gone**.

---

## 5 · The warehouse cannot fill it

**Do**

1. Open **SR-000005** → **إنشاء التحويل**.
2. Press **تحويل وترحيل**.

**Expect**

- **Refused**, naming the item. `جل تصفيف الشعر` needs **30** pieces and the main
  warehouse holds **9**.
- Nothing is created. SR-000005 stays **موافَق عليه**.
- The other two lines are *not* transferred either — it is one voucher, all or
  nothing.

This is correct behaviour, not a failure. To clear it, reduce that line's
quantity on the transfer page and post the rest.

---

## 6 · The same goods cannot move twice

The important one, because it is silent when it goes wrong.

**Do**

1. Take any request that is **بانتظار الاستلام** on the phone.
2. On the dashboard, do **إنشاء التحويل** → **تحويل وترحيل**.
3. Now, on the phone, press **استلمت البضاعة** on that same request.

**Expect**

- The phone shows an error, not a success.
- Van stock goes up **once**. Check it in **أرصدة المخزون** before and after: the
  quantity must rise by the granted amount, not double it.

**Then the reverse:** on another request, press **استلمت البضاعة** on the phone
*first*. The dashboard's **إنشاء التحويل** button should no longer be offered,
because the request is already **تم الاستلام**.

---

## 7 · Reject, then delete

**Do**

1. Send a throwaway request from the phone.
2. On the dashboard, open it and press **حذف**.
3. **Expect: refused** — it tells you to reject it first, so the rep gets a
   reason.
4. **رفض** with a reason.
5. **Expect:** the phone shows **مرفوض** with your reason, word for word.
6. Now press **حذف** and confirm.

**Expect**

- It disappears from the **مرفوضة** tab.
- The record is still in the database. Check:

```bash
psql -d flowvan -c "SELECT request_number, status, deleted_at FROM stock_requests WHERE deleted_at IS NOT NULL;"
```

**Also try:** open a request that is **تم الاستلام** and look for **حذف**. It
should not be there — stock moved against it, and the transfer voucher would be
left with nothing explaining why it exists.

---

## 8 · The ERP sees it

**Do**

1. ERP → **جلسات المركبات** → open a session for van `جهاد مندب`. If none
   exists: **فتح تحميل**, van = `جهاد مندب`, source = `المستودع الرئيسي`.
2. Scroll to **طلبات بضاعة من المركبة**.

**Expect**

- The approved requests are listed, newest first, with the rep's name.
- A line granted less than requested reads `8 approved (12 requested)`.
- Requests already fulfilled read **تم الاستلام**; the rest read **بانتظار
  التحميل** with an **إنشاء التحويل** link.

3. Press **إنشاء التحويل** on an open one.

**Expect**

- The ERP's new-transfer form opens with source, destination and one row per
  approved line, each showing a real item name — not a blank row.
- After saving, that request flips to **تم الاستلام** on the van session page.

---

## 9 · Several at once

Send **three** requests from the phone without waiting for a decision.

**Expect**

- All three succeed. There is no limit.
- All three appear in the office queue, newest first.
- Under **طلباتي** each carries its own status, and approving one does not touch
  the others.

---

## If the phone cannot log in

The salesman accounts have no known password on this machine. Set one:

```bash
psql -d flowvan -c "UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE user_number='admin') WHERE user_number='101';"
```

That gives salesman `101` the same password as admin — `admin1234`. Development
machine only.

---

## Putting the data back

Tests 4, 6 and 8 post real transfers and really move stock. To see what changed:

```bash
psql -d flowvan -c "SELECT voucher_number, trans_kind, in_date FROM voucher_headers WHERE trans_kind='TRANSFER' ORDER BY in_date DESC LIMIT 5;"
```

Leave them. Reversing a posted voucher by hand desynchronises `item_balance`
from the voucher lines it is derived from, which is a worse state than a few
extra test transfers.
