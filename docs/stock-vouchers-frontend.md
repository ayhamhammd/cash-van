# Stock Movement via Vouchers — Frontend Implementation Guide

How **per-stock quantity** is driven by vouchers, and how the dashboard should
create / post the stock voucher kinds — **Sale**, **Return**, **Order**, **In**,
**Out**, and **Transfer** — so that each stock's quantity updates correctly.

> Base URL: `https://<host>/api/v1`
> Auth: `Authorization: Bearer <jwt>` on every request.

---

## 1. The model in one paragraph

Every **stock** (a warehouse, `wh_number`) keeps its **own separate quantity**
per item. That quantity is **not stored as a single number** — it is **derived**
from *posted* voucher lines. Each voucher line declares which stock loses qty and
which stock gains qty:

| Field on a voucher line | Meaning | Effect on that stock |
|---|---|---|
| `fromStoreNumber` | stock that **loses** qty (outflow) | `qty -= itemQty` |
| `toStoreNumber`   | stock that **gains** qty (inflow)  | `qty += itemQty` |

A voucher only affects stock **after it is posted** (`PATCH /vouchers/:id/post`).
Draft (unposted) vouchers do **not** change any balance.

### How each voucher type maps to from/to

| Voucher type | Header `transKind` | Per line you send | Resulting movement |
|---|---|---|---|
| **Sale** | `SALE` | `storeNumber` (the selling stock) | that stock `-qty` |
| **Return** | `RETURN` | `storeNumber` (the receiving stock) | that stock `+qty` |
| **Order** | `ORDER` | `storeNumber` (informational) | **no stock change** (reservation until fulfilled) |
| **In** | `IN` | `storeNumber` (the receiving stock) | that stock `+qty` |
| **Out** | `OUT` | `storeNumber` (the issuing stock) | that stock `-qty` |
| **Transfer** (stock → stock) | `TRANSFER` | `fromStoreNumber` **and** `toStoreNumber` | source `-qty`, destination `+qty` (one voucher) |

These are the only voucher kinds the stock screens use.

- **Single-stock kinds** (`SALE`, `RETURN`, `IN`, `OUT`) take one `storeNumber`.
  The backend turns it into `fromStoreNumber` (for the out kinds `SALE`/`OUT`,
  qty decreases) or `toStoreNumber` (for the in kinds `RETURN`/`IN`, qty
  increases) automatically.
- **`TRANSFER`** is the only kind that touches two stocks: send both
  `fromStoreNumber` and `toStoreNumber` on **every line** — one voucher moves qty
  out of the source and into the destination.
- **`ORDER`** reserves goods but does **not** change the stock balance until the
  order is fulfilled (`PATCH /vouchers/:id/fulfill`).

---

## 2. Read the current stock balance

**`GET /items/balance/list`** — quantity per item per stock (posted vouchers only).

Query params (both optional):

| Param | Description |
|---|---|
| `itemNumber` | filter to one item, e.g. `IT-1001` |
| `stockNumber` | filter to one stock, e.g. `ST-01` |

**Response** `200`:

```json
[
  { "itemNumber": "IT-1001", "itemName": "Pepsi 330ml", "stockNumber": "ST-01", "qty": "120.000" },
  { "itemNumber": "IT-1001", "itemName": "Pepsi 330ml", "stockNumber": "ST-02", "qty": "35.000" },
  { "itemNumber": "IT-1002", "itemName": "Water 1L",    "stockNumber": "ST-01", "qty": "0.000" }
]
```

- `qty` is a **string** decimal (`numeric(14,3)`). Parse with `Number(qty)`.
- One row per `(item, stock)`. An item with no movements appears once with
  `stockNumber: null` and `qty: "0.000"`.
- Re-fetch this after posting a voucher to show the updated stock.

---

## 3. Create a voucher

**`POST /vouchers`** — creates the voucher as a **draft** (`isPosted: false`).
Requires the `canMakeVoucher` permission.

### Common header fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `voucherNumber` | string | ✅ | unique; your app generates it |
| `transKind` | string | ✅ | `SALE` \| `RETURN` \| `ORDER` \| `IN` \| `OUT` \| `TRANSFER` |
| `userCode` | string | ✅ | the acting user's `userNumber` |
| `customerNumber` | string | for SALE/RETURN/ORDER | the customer |
| `vendorNumber` | string | optional | — |
| `inDate` | ISO string | optional | defaults to now |
| `totalDiscountValue` | string | optional | header-level discount |
| `isPosted` | boolean | optional | leave `false`; post in a second step |
| `transactions` | line[] | ✅ | at least 1 line |
| `payments` | payment[] | optional | for SALE collections |

### Line fields (`transactions[]`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `itemNumber` | string | ✅ | catalog item |
| `itemName` | string | ✅ | display name snapshot |
| `itemQty` | string | ✅ | quantity, `> 0`, e.g. `"10.000"` |
| `unitPrice` | string | ✅ | `>= 0`, e.g. `"1.250"` |
| `storeNumber` | string | SALE / RETURN / IN / OUT / ORDER | the affected stock |
| `fromStoreNumber` | string | **TRANSFER** | source stock (loses qty) |
| `toStoreNumber` | string | **TRANSFER** | destination stock (gains qty) |
| `taxPercentage` | string | optional | default `"0"` |
| `discountPercentage` | string | optional | default `"0"` |
| `discountValue` | string | optional | default `"0"` |

### 3a. Transfer (stock → stock)

```json
POST /api/v1/vouchers
{
  "voucherNumber": "TRF-2026-0001",
  "transKind": "TRANSFER",
  "userCode": "U-001",
  "transactions": [
    {
      "itemNumber": "IT-1001",
      "itemName": "Pepsi 330ml",
      "itemQty": "20.000",
      "unitPrice": "0.000",
      "fromStoreNumber": "ST-01",
      "toStoreNumber": "ST-02"
    }
  ]
}
```

After posting: `ST-01` for `IT-1001` drops by 20, `ST-02` rises by 20.

**Validation enforced by the backend** (surface these as form errors):
- every TRANSFER line must have **both** `fromStoreNumber` and `toStoreNumber`
  → `400 "A TRANSFER line requires both fromStoreNumber and toStoreNumber"`
- `fromStoreNumber` must differ from `toStoreNumber`
  → `400 "TRANSFER fromStoreNumber and toStoreNumber must be different stocks"`

### 3b. Sale

```json
POST /api/v1/vouchers
{
  "voucherNumber": "SAL-2026-0001",
  "transKind": "SALE",
  "userCode": "U-001",
  "customerNumber": "C-1001",
  "transactions": [
    {
      "itemNumber": "IT-1001",
      "itemName": "Pepsi 330ml",
      "itemQty": "5.000",
      "unitPrice": "1.250",
      "storeNumber": "ST-01",
      "taxPercentage": "16"
    }
  ],
  "payments": [
    { "amount": "7.250", "paymentType": "CASH" }
  ]
}
```

After posting: `ST-01` for `IT-1001` drops by 5.

### 3c. Return

```json
POST /api/v1/vouchers
{
  "voucherNumber": "RET-2026-0001",
  "transKind": "RETURN",
  "userCode": "U-001",
  "customerNumber": "C-1001",
  "transactions": [
    {
      "itemNumber": "IT-1001",
      "itemName": "Pepsi 330ml",
      "itemQty": "2.000",
      "unitPrice": "1.250",
      "storeNumber": "ST-01"
    }
  ]
}
```

After posting: `ST-01` for `IT-1001` rises by 2.

### 3d. In (stock receipt)

Adds qty into a stock. Same shape as Return but `transKind: "IN"`.

```json
POST /api/v1/vouchers
{
  "voucherNumber": "IN-2026-0001",
  "transKind": "IN",
  "userCode": "U-001",
  "transactions": [
    {
      "itemNumber": "IT-1001",
      "itemName": "Pepsi 330ml",
      "itemQty": "100.000",
      "unitPrice": "0.000",
      "storeNumber": "ST-01"
    }
  ]
}
```

After posting: `ST-01` for `IT-1001` rises by 100.

### 3e. Out (stock issue)

Removes qty from a stock. Same shape but `transKind: "OUT"`.

```json
POST /api/v1/vouchers
{
  "voucherNumber": "OUT-2026-0001",
  "transKind": "OUT",
  "userCode": "U-001",
  "transactions": [
    {
      "itemNumber": "IT-1001",
      "itemName": "Pepsi 330ml",
      "itemQty": "8.000",
      "unitPrice": "0.000",
      "storeNumber": "ST-01"
    }
  ]
}
```

After posting: `ST-01` for `IT-1001` drops by 8.

### 3f. Order (reservation — no stock change)

An order reserves goods but does **not** change the stock balance when posted.
The stock moves only when the order is fulfilled.

```json
POST /api/v1/vouchers
{
  "voucherNumber": "ORD-2026-0001",
  "transKind": "ORDER",
  "userCode": "U-001",
  "customerNumber": "C-1001",
  "transactions": [
    {
      "itemNumber": "IT-1001",
      "itemName": "Pepsi 330ml",
      "itemQty": "12.000",
      "unitPrice": "1.250",
      "storeNumber": "ST-01"
    }
  ]
}
```

After posting: no change to `item_balance`. Call `PATCH /vouchers/:id/fulfill`
to release the reservation and ship the goods.

**Response** of `POST /vouchers` is the created voucher (with `id`, `isPosted: false`,
`transactions`, `payments`). Keep the `id` for the post step.

---

## 4. Post the voucher (apply it to stock)

**`PATCH /vouchers/:id/post`** — makes the voucher immutable and applies its
effect to the stock balances. Requires `canMakeVoucher`.

```
PATCH /api/v1/vouchers/4f3c.../post   → 200, voucher with isPosted: true
```

- **Stock balances only change at this step.** Before posting, the voucher is a
  draft and `GET /items/balance/list` ignores it.
- Posting twice → `409 "Voucher already posted"`.
- A posted voucher cannot be edited or deleted (`403`).

### Recommended UX flow

```
Create draft (POST /vouchers)
        │
        ▼
Review screen ── (edit while draft: PATCH /vouchers/:id)
        │
        ▼
Confirm  ──►  POST /vouchers/:id/post   ──►  refresh /items/balance/list
```

You may also create-and-post in one shot by sending `"isPosted": true` in
`POST /vouchers`, but the two-step flow lets the user review before stock moves.

---

## 4b. Every salesman is a stock (auto-created)

A salesman (rep) **is** a stock — his van. When you create a salesman, the
backend **automatically creates a warehouse/stock and links it** to the rep via
`vanId`. You do **not** need a separate "create store" step.

**`POST /reps`**

```json
POST /api/v1/reps
{
  "code": "S-105",
  "nameAr": "خالد العلي",
  "nameEn": "Khaled Al-Ali",
  "phone": "+962790000000"
}
```

**Response** `201` — the rep now has a `vanId` pointing at the new store:

```json
{
  "id": "9b1e...",
  "code": "S-105",
  "nameAr": "خالد العلي",
  "vanId": "c4d2...",          // ← auto-created store
  "isActive": true
}
```

- The store's `whNumber` is derived from the salesman code → **`VAN-S-105`**
  (or `VAN-<short-id>` if the rep has no code; a numeric suffix is appended if
  that number is already taken).
- The store's `whName` is the salesman's name.
- If you pass an existing `vanId` in the request, no new store is created — the
  rep is linked to that store instead.
- To resolve a salesman's store for the stock screens: take `rep.vanId`, then
  `GET /warehouses` and match by `id` to get its `whNumber` (the value used as
  `storeNumber` / `fromStoreNumber` / `toStoreNumber` in vouchers).

This means a Sale from a salesman's van, or a Transfer into/out of it, just uses
that salesman's store number like any other stock.

---

## 5. Lookups the screens need

| Data | Endpoint |
|---|---|
| Stocks / warehouses | `GET /warehouses` |
| Catalog items | `GET /items` (paginated) |
| Item by barcode | `GET /items/barcode/:barcode` |
| Transaction kinds | `GET /vouchers/kinds` |
| Current balances | `GET /items/balance/list` |

Use `GET /warehouses` to populate the **From stock** / **To stock** / **Stock**
dropdowns (value = `whNumber`, label = `whName`).

---

## 6. TypeScript types

```ts
export type VoucherKind =
  | 'SALE'
  | 'RETURN'
  | 'ORDER'
  | 'IN'
  | 'OUT'
  | 'TRANSFER';

export interface VoucherLine {
  itemNumber: string;
  itemName: string;
  itemQty: string;            // "> 0"
  unitPrice: string;          // ">= 0"
  storeNumber?: string;       // SALE / RETURN / IN / OUT / ORDER
  fromStoreNumber?: string;   // TRANSFER
  toStoreNumber?: string;     // TRANSFER
  taxPercentage?: string;
  discountPercentage?: string;
  discountValue?: string;
}

export interface VoucherPayment {
  amount: string;
  paymentType: 'CASH' | 'CHEQUE' | 'TRANSFER' | 'CARD' | 'CREDIT';
  paymentDate?: string;
  fromAcc?: string;
  toAcc?: string;
}

export interface CreateVoucher {
  voucherNumber: string;
  transKind: VoucherKind;
  userCode: string;
  customerNumber?: string;
  vendorNumber?: string;
  inDate?: string;
  totalDiscountValue?: string;
  totalDiscountPercentage?: string;
  isPosted?: boolean;
  transactions: VoucherLine[];
  payments?: VoucherPayment[];
}

export interface ItemBalanceRow {
  itemNumber: string;
  itemName: string;
  stockNumber: string | null;
  qty: string;                // numeric(14,3) as string
}
```

---

## 7. Client helpers

```ts
const API = '/api/v1';
const authHeaders = (token: string) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

// Build a single-stock voucher (SALE / RETURN / IN / OUT / ORDER).
export function buildSingleStock(p: {
  voucherNumber: string;
  kind: Exclude<VoucherKind, 'TRANSFER'>;
  userCode: string;
  store: string;
  customerNumber?: string;
  lines: { itemNumber: string; itemName: string; qty: string; unitPrice?: string }[];
}): CreateVoucher {
  return {
    voucherNumber: p.voucherNumber,
    transKind: p.kind,
    userCode: p.userCode,
    customerNumber: p.customerNumber,
    transactions: p.lines.map((l) => ({
      itemNumber: l.itemNumber,
      itemName: l.itemName,
      itemQty: l.qty,
      unitPrice: l.unitPrice ?? '0.000',
      storeNumber: p.store,
    })),
  };
}

// Build a TRANSFER voucher from a stock-to-stock form.
export function buildTransfer(p: {
  voucherNumber: string;
  userCode: string;
  fromStore: string;
  toStore: string;
  lines: { itemNumber: string; itemName: string; qty: string }[];
}): CreateVoucher {
  return {
    voucherNumber: p.voucherNumber,
    transKind: 'TRANSFER',
    userCode: p.userCode,
    transactions: p.lines.map((l) => ({
      itemNumber: l.itemNumber,
      itemName: l.itemName,
      itemQty: l.qty,
      unitPrice: '0.000',
      fromStoreNumber: p.fromStore,
      toStoreNumber: p.toStore,
    })),
  };
}

export async function createAndPost(token: string, body: CreateVoucher) {
  const created = await fetch(`${API}/vouchers`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  }).then((r) => r.json());

  await fetch(`${API}/vouchers/${created.id}/post`, {
    method: 'PATCH',
    headers: authHeaders(token),
  });

  return created.id as string;
}

export async function getBalances(
  token: string,
  q: { itemNumber?: string; stockNumber?: string } = {},
): Promise<ItemBalanceRow[]> {
  const qs = new URLSearchParams(q as Record<string, string>).toString();
  return fetch(`${API}/items/balance/list?${qs}`, {
    headers: authHeaders(token),
  }).then((r) => r.json());
}
```

---

## 8. Client-side validation checklist

Mirror these to avoid round-trips:

- `itemQty > 0`, `unitPrice >= 0` on every line.
- **Transfer:** `fromStoreNumber` and `toStoreNumber` are both set and **different**.
- **Sale / Return / In / Out / Order:** `storeNumber` is set on every line.
- `voucherNumber` is unique (server returns `409` on duplicate).
- (Optional, advisory) For Transfer / Sale / Out, warn if `itemQty` exceeds the
  source stock's current `qty` from `GET /items/balance/list`. The backend does
  **not** block negative stock, so enforce it in the UI if your business requires it.

---

## 9. Error responses to handle

| Status | When | Message example |
|---|---|---|
| `400` | bad transfer line | `A TRANSFER line requires both fromStoreNumber and toStoreNumber` |
| `400` | same source/dest | `TRANSFER fromStoreNumber and toStoreNumber must be different stocks` |
| `400` | bad qty/price | `itemQty must be > 0` / `unitPrice must be >= 0` |
| `400` | unknown kind | `Unknown trans_kind: ...` |
| `403` | edit/delete posted | `Cannot edit a posted voucher` |
| `409` | duplicate number | `Voucher <n> already exists` |
| `409` | re-post | `Voucher already posted` |

---

## 10. Summary

1. **Stock qty is per stock and derived** from posted voucher lines.
2. A line moves qty from `fromStoreNumber` (−) to `toStoreNumber` (+).
3. Voucher kinds: **Sale** (−), **Return** (+), **In** (+), **Out** (−) each use
   one `storeNumber`; **Transfer** uses `fromStoreNumber` + `toStoreNumber` on
   each line (single voucher); **Order** reserves only (no stock change until
   fulfilled).
4. Stock changes **only on `POST /vouchers/:id/post`** (Order: on fulfil).
5. Read live numbers from **`GET /items/balance/list`** and refresh after posting.
</content>
