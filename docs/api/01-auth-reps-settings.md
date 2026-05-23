# API — Plan 01 · Auth, Reps, App Settings

> Envelopes are documented once in [`docs/api/00.5-preflight.md`](./00.5-preflight.md).
> Success = `{ success: true, data: <T>, timestamp }`.
> Error = `{ statusCode, message, error, path, timestamp }`.

Base URL: `/api/v1/`

---

## Auth (changed)

JWT payload now includes `role`:

```json
{
  "sub":        "uuid",
  "v":          2,
  "userNumber": "admin",
  "userType":   "ADMIN",
  "role":       "admin",
  "permissions": { "...": true }
}
```

`role` ∈ `admin | manager | supervisor | viewer`. Drives `@Roles()` checks.

### `POST /api/v1/auth/login`

Public.

**Request body**
```json
{ "userNumber": "admin", "password": "admin1234" }
```

**Response** — `200 OK`, `data:`
```json
{
  "accessToken": "<jwt>",
  "user": {
    "id": "uuid",
    "userNumber": "admin",
    "name": "Default Admin",
    "userType": "ADMIN",
    "role": "admin",
    "permissions": { "canMakeVoucher": true, "...": true }
  }
}
```

**Possible errors**: `401 UnauthorizedException`, `400 BadRequestException` (validation), `429 ThrottlerException`.

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}'
```

---

## Reps — `/api/v1/reps`

Header on all: `Authorization: Bearer <jwt>`.

### `GET /api/v1/reps` — list with filters

**Query params**
| Param | Type | Notes |
|---|---|---|
| `regionId` | uuid | optional |
| `isActive` | boolean | optional |
| `q` | string | substring on `name_ar / name_en / phone` (case-insensitive) |
| `limit` | int | 1–200, default 50 |
| `offset` | int | ≥ 0, default 0 |

**Response data**
```ts
{
  items: Rep[];
  total: number;
}
```

`Rep` shape:
```ts
{
  id: string;
  userId: string | null;
  nameAr: string;
  nameEn: string | null;
  phone: string | null;
  regionId: string | null;
  vanId: string | null;
  isActive: boolean;
  hireDate: string | null;        // YYYY-MM-DD
  dailyQuotaFils: number | null;  // 1 JOD = 1000 fils
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
}
```

**Possible errors**: `400 BadRequestException` (bad query), `401 UnauthorizedException`.

### `GET /api/v1/reps/:id`
Returns one `Rep`.
**Possible errors**: `400 BadRequestException` (bad UUID), `401`, `404 NotFoundException`.

### `GET /api/v1/reps/:id/kpis`
Stub. Real numbers ship with plan 06 (invoices).
**Response data**: `{ todayRevenueFils: 0, routeCompletionPct: 0, invoicesToday: 0, customersAtRisk: 0 }`
**Possible errors**: `400`, `401`, `404`.

### `POST /api/v1/reps` — `@Roles('admin','manager')`

**Request body** (`CreateRepDto`)
```ts
{
  nameAr: string;                  // required
  nameEn?: string;
  phone?: string;
  userId?: string;                 // link to dashboard user
  regionId?: string;
  vanId?: string;
  isActive?: boolean;              // default true
  hireDate?: string;               // YYYY-MM-DD
  dailyQuotaFils?: number;         // >= 0
}
```

**Response** — `201 Created`, `data: Rep`.

**Possible errors**: `400`, `401`, `403 ForbiddenException`.

```bash
curl -X POST http://localhost:3000/api/v1/reps \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"nameAr":"خالد العلي","nameEn":"Khaled","phone":"+962790000001","dailyQuotaFils":500000}'
```

### `PATCH /api/v1/reps/:id` — `@Roles('admin','manager')`
Same body as `CreateRepDto`, all fields optional. Returns updated `Rep`.
**Possible errors**: `400`, `401`, `403`, `404`.

### `DELETE /api/v1/reps/:id` — `@Roles('admin')`
Soft-deletes. **Response** — `204 No Content`.
**Possible errors**: `400`, `401`, `403`, `404`.

---

## App Settings — `/api/v1/settings` — `@Roles('admin')`

Single-row table. The JoFotara secret is never returned in plaintext.

### `GET /api/v1/settings`

**Response data**
```ts
{
  companyNameAr: string;
  companyNameEn: string | null;
  sellerTin: string | null;
  sellerAddress: string | null;
  sellerPhone: string | null;
  sellerCityCode: string | null;     // e.g. "JO-AM"
  timezone: string;                   // default "Asia/Amman"
  locale: string;                     // default "ar"
  aiChatQuota: number;
  aiInferQuota: number;
  jofotara: {
    clientId: string | null;
    secretLast4: string | null;
    sandbox: boolean;
    isConfigured: boolean;
  };
  updatedAt: string;
  updatedBy: string | null;           // user id
}
```

**Possible errors**: `401`, `403`.

### `PATCH /api/v1/settings`
Updates non-secret fields. Body is a partial of the above shape (excluding `jofotara`, `updatedAt`, `updatedBy`). Returns the same view.
**Possible errors**: `400`, `401`, `403`.

### `PATCH /api/v1/settings/jofotara` — rotate credentials

**Request body**
```ts
{
  clientId: string;          // required
  secretKey: string;         // required, plaintext (encrypted before storage)
  sandbox?: boolean;
}
```

**Response data**
```ts
{
  clientId: string;
  secretLast4: string;       // last 4 chars of the plaintext
  sandbox: boolean;
  updatedAt: string;
}
```

The plaintext `secretKey` is **never** echoed back. Storage uses AES-256-GCM with the key from env `JOFOTARA_KMS_KEY`.

**Possible errors**: `400`, `401`, `403`.

```bash
curl -X PATCH http://localhost:3000/api/v1/settings/jofotara \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"clientId":"abc-trading","secretKey":"super-secret-1234","sandbox":true}'
```

---

## Swagger

All routes above are decorated with `@ApiTags`, `@ApiOperation`, `@ApiBearerAuth`, and request bodies use class-validator + `@ApiProperty` so they render fully at:

```
http://localhost:3000/docs
```
