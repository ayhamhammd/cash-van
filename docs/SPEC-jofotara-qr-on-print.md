# JoFotara QR on the printed receipt — spec

> Status: **server DONE, app PENDING** · Owner: backend · Consumers: FlowVan mobile
> Sibling: the app change this asks for lives in `FlowVan/`

A rep sells, the receipt prints, and the customer's copy must carry the JoFotara
QR. This is the contract the backend now offers for that, and the app change
still needed to use it.

---

## 1. What was wrong

The app already held the receipt for up to 8 seconds waiting for a QR. The
server could not answer in 8 seconds, for three reasons that stacked:

| | |
|---|---|
| Nothing pushed a posted sale | the outbox row committed with the voucher, then waited up to `ERP_OUTBOX_DRAIN_MS` (30s) for a timer before the sale was even SENT to the ERP |
| The QR was discarded | the ERP's create reply can already name it; only the invoice number and journal info were read out of it |
| The poll starved new sales | candidates were paged with a rotating offset, so a voucher's turn came once per `ceil(N/20)` ticks — at N=200 that is **300 seconds**, and N only grows |

So the QR reached the handset minutes after the rep had printed and driven off.
All three are fixed; a sale's QR is now normally on the voucher within about a
second of posting.

**But a fast QR on the server is invisible to the rep until the app reads it.**
That is section 4.

---

## 2. The sale reply now carries the QR

`POST /api/v1/sync/vouchers` — unchanged request, unchanged `202`, two new
fields on the body:

```json
{
  "success": true,
  "data": {
    "id": "…", "clientRef": "…",
    "voucherNumber": "INV-110101000042",
    "status": "posted",
    "attempts": 1, "retryable": false, "error": null,

    "jofotaraQrCode": "<the QR payload to print>",
    "jofotaraStatus": "SUBMITTED"
  }
}
```

Rules:

- Both fields appear **only for a posted `SALE`**. Absent for `RETURN`, `ORDER`,
  `CONTAINER_IN`/`OUT`, and for a sale that was staged or rejected.
- `jofotaraQrCode: null` means **not issued yet**, not an error. The ERP files
  with the government asynchronously; print without it (see §5).
- The server spends at most `SYNC_QR_WAIT_MS` (default 4000, max 8000, `0` off)
  getting it — deliberately under the app's own wait, so the server is never
  what makes a rep wait longer.
- Everything else on the reply is untouched. `status` still decides whether the
  handset may drop its local copy, and no QR failure can change it.

A **replayed** post (same `clientRef`, e.g. the first request timed out) gets
the QR too — that handset is still standing there waiting to print.

## 3. Asking again

`GET /api/v1/sync/vouchers/{voucherNumber}/jofotara`

```json
{ "success": true,
  "data": { "voucherNumber": "INV-…", "jofotaraQrCode": "…", "jofotaraStatus": "SUBMITTED" } }
```

Asks the ERP about that one invoice by number, so it answers at once instead of
waiting for the background poll to come round. Cheap when the QR is already
stored (no ERP call at all).

| Case | Answer |
|---|---|
| QR stored, or document that never gets one | returned immediately, no ERP call |
| Not issued yet | `jofotaraQrCode: null` + whatever status is known |
| Another rep's sale | `403` — own sale only, unless permitted to act on their behalf |
| Unknown voucher | `404` |
| No token | `401` |

---

## 4. The app change

### 4.1 Read the fields
Add `jofotaraQrCode` and `jofotaraStatus` to the sync-voucher response model.
**Until this is done nothing else in this spec has any effect** — the app
discards them and the rep sees no change.

### 4.2 Print as soon as the QR is in that reply
The blind wait is no longer the normal path. Once the reply carries a QR, print:

```
post sale ─► reply.jofotaraQrCode present ─► PRINT WITH QR      (the common case)
                      │
                      └─ null ─► §4.3
```

Dropping the unconditional 8-second hold is most of the win the rep actually
feels.

### 4.3 When it is null, ask once or twice, then print anyway
Within whatever remains of the app's own budget, call §3 once or twice (about a
second apart — the ERP is itself waiting on the government, so asking faster
answers nothing). Then print, with the QR if it arrived and without it if not.

Never block the rep past the budget. A sale that cannot be printed is worse
than a receipt whose QR is reprinted later.

### 4.4 Store it on the local voucher
Persist the QR with the voucher so a **reprint** carries it, and when it is
still missing let a reprint fetch it through §3. This is the path that makes a
late QR recoverable without the office getting involved.

### 4.5 Keep honouring `jofotaraAutoSubmit`
`GET /api/v1/company-info` carries `jofotaraAutoSubmit` (`true` | `false` |
`null`). With it `false` the ERP never files the invoice, so **no sale will ever
have a QR** and waiting is pure delay. `null` means not known — keep waiting,
because a missing QR on an invoice that WAS filed is worse than a brief wait.
The server now applies the same rule, so with the switch off neither side waits.

---

## 5. Edge cases

| Case | Expected behaviour |
|---|---|
| QR not issued inside the budget | print without it; the poll fills the voucher in, and a reprint carries it |
| Sale rejected or still staged | no QR, and none is asked for — `status` is what the app acts on |
| ERP unreachable / switched off | reply has no QR; the sale is still `posted` and must be treated as such |
| Auto-submit off | no wait anywhere; receipts print immediately, permanently without a QR |
| Reprint of an old sale | read the stored QR, else §3 |
| Two handsets, same `clientRef` | both get the same QR; the fetch is idempotent |

**Never** print a QR obtained for a different invoice. The ERP matches invoice
numbers as a *substring*, so a question about `SI-12` can come back holding
`SI-120`; the server only accepts an exact match, and a past bug there put the
wrong QR on a voucher. A wrong QR on a customer's receipt is worse than none.

---

## 6. Acceptance

1. Post a sale with the ERP reachable and auto-submit on → the reply carries a
   QR, and the receipt prints with it without an 8-second pause.
2. Post a sale while the ERP withholds the QR → reply has `jofotaraQrCode: null`,
   the app asks again, then prints (with or without) inside its budget.
3. Auto-submit off → no QR, no wait, receipt prints at once.
4. Reprint a sale whose QR arrived later → the QR is on the reprint.
5. Ask for another rep's sale → `403`.
6. ERP down → sale still reports `posted`; the app keeps its copy per `status`
   exactly as before.

Server-side coverage for all of §2 and §3 is in
`src/modules/sync/qr-on-intake.spec.ts`,
`src/modules/erp-sync/erp-outbox.qrDirect.spec.ts`,
`src/modules/erp-sync/erp-outbox.qrOnPush.spec.ts`,
`src/modules/erp-sync/erp-outbox.pushOnPost.spec.ts` and
`src/modules/erp-sync/jofotara-qr-reconcile.integration.spec.ts`.
