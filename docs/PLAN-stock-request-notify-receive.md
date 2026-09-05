# PLAN — Stock request: notify the rep on approval, and confirm-to-receive

The salesman raises a van stock request; a manager approves it; the salesman is
**notified**, then **confirms receipt of the exact items and quantities**, and only
then does the van's stock move.

## The important finding: most of this already exists

Before planning new work, here is what the code already does (verified 2026-08-23):

**Backend — the whole flow is built.**
- Statuses: `pending → approved → received` (also `rejected`, `cancelled`).
- `POST /stock-requests/:id/approve` — manager approves; `announceDecided()` already
  **notifies the requesting rep** via `NotificationsService.notifyUser(requesterUser, …)`,
  and calls out partial grants specifically.
- `POST /stock-requests/:id/receive` — **requester-only**; `markReceived()` raises the
  source→van TRANSFER voucher, **moves van stock**, pushes to the ERP outbox, and notifies
  the rep that their van changed. Stock moves on the rep's confirmation, not before.
- Notifications are persisted (`AppNotification`) and `notification.created` is emitted;
  `GET /notifications`, `POST /notifications/:id/read`, `read-all` all exist.

**Mobile — create, list, and receive are built.**
- `StockRequestApi` has `create`, `mine`, `mainStoreStock`, `cancel`, and `receive`.
- `StockRequestViewModel` loads `mine()` and handles a `Receive` event → `api.receive(id)`.
- `StockRequestScreen` renders the rep's requests with a Receive action per row.
- DTOs carry everything the confirm screen needs: `status`, per-line `itemName`,
  `approvedBaseQty`, `unitName`, `unitBaseQty`.

So the request → approve → (rep) receive → van-stock-moves mechanism **works today**.

## What is actually missing

1. **The rep never SEES the approval notification on the phone.** The backend creates
   it, but the mobile app has **no notifications feature at all** — no push, no polling of
   `GET /notifications`, no badge, no list. The alert exists server-side and dies there.
   This is the real gap and the bulk of the work.

2. **The receive step does not show the items and quantities being confirmed.** The row has
   a Receive button, but the rep should see *what* they are receiving (each approved item +
   quantity) before confirming — the request explicitly asks for this.

3. **No visual "approved — awaiting your receipt" state** to pull the rep back to confirm.

Nothing on the server needs redesigning; the notification *field/record* the request asks
for is already there. The work is delivering it to the handset and polishing the confirm UI.

## Hard constraint that decides the design

The client's test handset is **GMS-less** (earlier logs showed Google Play Services
`SERVICE_DISABLED`). **Firebase/FCM push will not work on it.** So notification delivery
must be **in-app polling**, not push. This is simpler anyway and needs no Firebase project,
no device-token table, no cloud credentials.

---

## Plan

### 1. Backend — small additions only

The flow is built; add just enough to make mobile polling clean.

- **Confirm the approval notification carries a type + the request id** in its payload, so
  the app can deep-link to the request. `notifyUser` takes a `NotifyInput`; ensure the
  approval and received notifications include `{ type: 'STOCK_REQUEST_APPROVED' | '…_RECEIVED',
  entityId: request.id }`. (If already present, no change.)
- **Nothing else.** `GET /notifications?unread=…&limit=…` and the read endpoints already
  exist and are what the app will poll.

### 2. Mobile — notifications delivery (the main work)

- **`NotificationApi`** (core:network): `list(unreadOnly, limit)`, `markRead(id)`,
  `markAllRead()` against the existing `/notifications` endpoints. Add `AppNotificationDto`.
- **Polling**, not push (GMS-less): a lightweight `NotificationsViewModel` that fetches
  unread on app foreground (`ON_RESUME`) and on a modest interval while active. Store the
  unread count in a shared session/UI state.
- **Home badge**: show the unread count on the home screen (a bell or a number on the stock
  tile). Tapping opens a **Notifications list** screen.
- **Notifications screen**: list of alerts (approved / received / rejected), each tappable;
  a `STOCK_REQUEST_APPROVED` row deep-links into the stock-request screen focused on that
  request. Mark-read on open.

### 3. Mobile — confirm-to-receive shows items + quantities

- Turn the row's Receive button into a **receipt confirmation sheet**: list every approved
  line (`itemName`, `unitName`, `approvedBaseQty` → pieces), a clear total, and a single
  "تأكيد الاستلام" (Confirm receipt) button that calls `api.receive(id)`.
- On success, the existing backend path moves van stock and returns the updated request; the
  row flips to `received` and the van-stock screen reflects the new quantities.
- Guard: only `approved` requests show the Receive action; `received` ones show a done state.

### 4. Dashboard — no change required

Approval already notifies and the transfer/receive split already exists. Optionally surface
"approved — awaiting rep receipt" vs "received" in the stock-requests queue so the office can
see which reps have not yet confirmed. Nice-to-have, not required.

---

## Sequencing

1. Backend notification payload check (½ day) — verify/emit `type` + `entityId`.
2. Mobile `NotificationApi` + DTO + polling ViewModel + unread count (1–2 days).
3. Home badge + Notifications screen + deep-link to a request (1–2 days).
4. Receipt confirmation sheet showing items/quantities (1 day).
5. Verify end-to-end on the GMS-less device: approve on dashboard → badge appears on phone →
   open → confirm receipt → van stock reflects.

## Out of scope / deferred

- **FCM push** — blocked by the GMS-less hardware; revisit only if the client's handsets gain
  Play Services. Polling covers the requirement.
- **Read receipts back to the office** (did the rep see it) — the backend can already tell
  approved-vs-received from status; a separate "seen" signal is not needed for this ask.
