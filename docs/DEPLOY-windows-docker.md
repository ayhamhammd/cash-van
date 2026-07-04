# Install on a Client Server with Docker (Windows 10)

Brings up the whole back office on one Windows 10 machine with Docker:
**API + PostgreSQL** (backend repo) and the **Dashboard** (frontend repo). The
mobile app (reps' phones) then points at this server's API.

| Service | Host port | Image |
|---|---|---|
| API (NestJS) | **3000** | built from `cash-van-dashboard/Dockerfile` |
| Dashboard (Next.js) | **8080** | built from `cash-van-dashboard-frontend/Dockerfile` |
| PostgreSQL 16 | 5432 (localhost only) | `postgres:16.4-alpine` |

> Replace `SERVER-IP` below with the server's LAN IP (run `ipconfig` → IPv4), or a
> domain if you have one. Reps' phones must be able to reach `http://SERVER-IP:3000`.

---

## 0. Prerequisites (once)

1. **Enable virtualization** in the BIOS (Intel VT-x / AMD-V) and turn on
   Windows features **WSL2** + **Virtual Machine Platform**:
   - PowerShell (Admin): `wsl --install` then reboot.
2. **Install Docker Desktop for Windows** (WSL2 backend): download from
   docker.com → run installer → keep "Use WSL 2" checked → reboot → launch Docker
   Desktop and wait for "Engine running".
   - Verify in PowerShell: `docker version` and `docker compose version`.
3. **Get the code** onto the server (Git for Windows, or copy the folders), e.g.:
   ```
   C:\cashvan\cash-van-dashboard            (backend)
   C:\cashvan\cash-van-dashboard-frontend   (frontend)
   ```

---

## 1. Backend — API + database

In PowerShell:
```powershell
cd C:\cashvan\cash-van-dashboard
copy .env.example .env
notepad .env
```
Set these in `.env` (leave the rest as-is):
```
NODE_ENV=production
DB_HOST=db
DB_USERNAME=cashvan
DB_PASSWORD=<a-strong-password>
DB_NAME=cashvan
JWT_SECRET=<long-random-string>
JOFOTARA_KMS_KEY=<64-hex-chars>          # REQUIRED in production (see below)
PHONE_HASH_SECRET=<random-string>
CORS_ORIGINS=http://SERVER-IP:8080
```
Generate the two secrets (any machine with OpenSSL, or Git Bash):
```bash
openssl rand -hex 32     # → JOFOTARA_KMS_KEY (encrypts ERP/AI/Hub API keys)
openssl rand -base64 48  # → JWT_SECRET
```
> ⚠️ `JOFOTARA_KMS_KEY` must be exactly **64 hex characters**. In production the API
> refuses to start without it (it's the key that encrypts stored ERP / AI / Hub
> credentials). Keep it safe — losing it means re-entering those keys.

Build and start (this uses the production override, and auto-runs
migrations + the admin seed on first boot):
```powershell
docker compose -f docker-compose.yml -f docker-compose.client.yml up -d --build
```
Check it's healthy:
```powershell
docker compose ps
docker compose logs -f app        # wait for "Cash Van API listening on ... :3000"
```
Verify from the server's browser: `http://localhost:3000/api/v1/health` → `{"status":"ok"}`.

Default login after seeding: **admin / admin1234** — change this immediately.

---

## 2. Frontend — dashboard

The dashboard bakes the API URL at **build time**, so it must be set before building.
```powershell
cd C:\cashvan\cash-van-dashboard-frontend
notepad .env
```
Put in `.env`:
```
NEXT_PUBLIC_API_BASE_URL=http://SERVER-IP:3000/api/v1
NEXT_PUBLIC_WS_URL=http://SERVER-IP:3000
NEXT_PUBLIC_DEFAULT_LOCALE=ar
PORT=8080
```
Build and start on port 8080:
```powershell
docker compose up -d --build
```
Open `http://SERVER-IP:8080` from any PC on the network → the dashboard loads → log in.

> If you later change the API URL, you must **rebuild** the dashboard
> (`docker compose up -d --build`) — env baked at build time won't pick up a restart.

---

## 3. Open the Windows firewall (LAN access)

So other PCs and phones can reach the server:
```powershell
New-NetFirewallRule -DisplayName "CashVan API"  -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "CashVan Dash" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
```

## 4. Point the mobile app at the server

In the mobile app's API config, set the base URL to `http://SERVER-IP:3000/api/v1`.
The reps' phones must be on the same network (or the server must be reachable via a
public domain — see Hardening).

---

## Day-2 operations

```powershell
# status / logs
docker compose ps
docker compose logs -f app

# stop / start / restart
docker compose stop
docker compose -f docker-compose.yml -f docker-compose.client.yml up -d

# update to a new version (after pulling new code)
docker compose -f docker-compose.yml -f docker-compose.client.yml up -d --build   # re-runs pending migrations

# backup the database (run in the backend folder)
docker compose exec db pg_dump -U cashvan cashvan > backup_$(Get-Date -Format yyyyMMdd).sql

# restore
Get-Content backup.sql | docker compose exec -T db psql -U cashvan -d cashvan

# optional DB admin UI (pgAdmin on http://localhost:8081)
docker compose --profile tools up -d pgadmin   # then map/visit its port
```
The database persists in the `cashvan_pgdata` Docker volume across restarts/updates.
Uploaded files persist in `cashvan_storage`.

---

## Hardening (recommended for real use)

- **HTTPS + a domain.** Mobile + browsers should use `https://`. Put a reverse proxy
  (Caddy or nginx) in front, terminating TLS, forwarding to :3000 and :8080. With a
  proxy, drop the `docker-compose.client.yml` port and use the stock
  `docker-compose.prod.yml` (which keeps the API internal). Set
  `NEXT_PUBLIC_API_BASE_URL=https://api.yourdomain` and `CORS_ORIGINS` to the HTTPS
  dashboard origin, then rebuild the dashboard.
- **Change the seed admin password** on first login.
- **Back up** `cashvan_pgdata` (or scheduled `pg_dump`) regularly.
- Keep `JOFOTARA_KMS_KEY` and `JWT_SECRET` in a safe place; changing `JOFOTARA_KMS_KEY`
  invalidates all stored encrypted credentials (ERP/AI/Hub keys must be re-entered).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `app` container restarts / exits | `docker compose logs app` — usually a missing `.env` value; in prod `JOFOTARA_KMS_KEY` must be 64 hex chars |
| Dashboard loads but "Loading…" forever / network errors | `NEXT_PUBLIC_API_BASE_URL` wrong or unreachable, or CORS — set `CORS_ORIGINS` to the dashboard origin and rebuild the dashboard |
| Phones can't connect | firewall rule (Step 3) + phones on the same LAN; use the server's LAN IP, not `localhost` |
| Port already in use | change the host port (`PORT=` for the dashboard; edit the `3000:3000` mapping for the API) |
| Login fails | seed didn't run — check `app` logs for the migration/seed step; default is admin / admin1234 |
