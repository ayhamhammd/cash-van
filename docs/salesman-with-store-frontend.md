# Create Salesman "Add with store" — Frontend Implementation Guide

How the **Create Salesman** form should expose the new **"Add with store"**
option, what it sends, and what the backend does with it.

> Base URL: `https://<host>/api/v1`
> Auth: `Authorization: Bearer <jwt>` on every request.
> Endpoint: `POST /reps` — **admin / manager** only.

---

## 1. What this feature does

When an admin/manager creates a salesman, they can tick a checkbox
**"Add with store"** (`createStore`). When ticked, the backend creates a
**store (warehouse)** for that salesman **in the same transaction** and links it
to him as his van/stock:

| Store field (`warehouses`) | Value taken from the salesman |
|---|---|
| `wh_number` (store number) | the salesman **`code`** — **same number** |
| `wh_name` (store name)     | the salesman **`nameAr`** (falls back to `nameEn`, then `code`) — **same name** |

The created store's id is written back to the rep as `vanId`, so the salesman
and his store are linked. When the checkbox is **off**, no store is created and
`vanId` stays `null`.

> The store number **is** the salesman code. There is no `VAN-` prefix — they
> are identical strings.

---

## 2. Request body

`POST /reps` accepts the existing fields plus one new optional boolean:

```jsonc
{
  "code": "S012",            // required when createStore = true
  "nameAr": "خالد العلي",     // required
  "nameEn": "Khaled Al-Ali", // optional
  "phone": "+962790000000",  // optional
  "createStore": true        // NEW — the "Add with store" checkbox
}
```

| Field | Type | Notes |
|---|---|---|
| `createStore` | `boolean` | Default `false`. The "Add with store" checkbox. |
| `code` | `string` | The salesman code. **Required if `createStore` is `true`** (it becomes the store number). |

All other fields (`regionId`, `vanId`, `isActive`, `hireDate`, `dailyQuotaFils`,
`userId`) are unchanged.

---

## 3. Form behaviour

1. Add a checkbox **"Add with store"** bound to `createStore` (default
   **unchecked**).
2. While it is checked, make the **Code** field **required** and show a hint:
   *"This code will also be used as the store number."*
3. Do **not** send `vanId` together with `createStore: true` — the two are
   mutually exclusive (the backend rejects it; see errors below).
4. After a successful create, the response `data.vanId` is populated with the new
   store id when `createStore` was true.

---

## 4. Success response

`201 Created` — the created rep (wrapped in the standard envelope):

```jsonc
{
  "success": true,
  "data": {
    "id": "dc2b48cc-…",
    "code": "S012",
    "nameAr": "خالد العلي",
    "nameEn": "Khaled Al-Ali",
    "vanId": "dc5631d1-…",   // ← id of the store created from the code/name
    "isActive": true
    // …
  },
  "timestamp": "2026-06-07T07:12:28.159Z"
}
```

The store itself then appears in the warehouses list
(`GET /warehouses`) with `whNumber` = `S012` and `whName` = `خالد العلي`.

---

## 5. Errors to handle

| HTTP | When | `message` |
|---|---|---|
| `400` | `createStore: true` but `code` is missing/empty | `A salesman code is required to create a store with the same number` |
| `400` | `createStore: true` sent together with `vanId` | `Cannot use "add with store" together with an existing vanId` |
| `409` | A store with that number already exists | `Store <code> already exists` |
| `409` | The salesman code is already used by another rep | `Salesman code "<code>" is already in use` |

Surface the `message` field to the user; the form should keep the entered values
so they can fix the code and resubmit.

---

## 6. Quick reference

- New field: **`createStore`** (boolean, optional, default `false`).
- When `true`: requires `code`, forbids `vanId`, creates a store with
  **number = code** and **name = name**, links it via `vanId`.
- When `false`/omitted: behaves like before — no store is created.
