# On-prem install (single client device, Docker)

Run the VanFlow API + its own PostgreSQL on one machine at the client's site.
The vans' phones and the dashboard reach it over the local network.

**Files:** `docker-compose.yml` (base services) + `docker-compose.client.yml` (production
override) — the client stack layers them · `.env.client.example` (config) ·
`scripts/build-onprem-bundle.sh` (offline bundle) · `scripts/init-db.sql` (DB extensions).

The device just needs **Docker** (Docker Desktop on Windows/Mac, Docker Engine on Linux).
Postgres is bundled — don't install it separately.

---

## Option A — device has internet (build on the device)

```bash
# copy this repo to the device, then:
cp .env.client.example .env          # then edit .env, replace every CHANGE_ME
# --build builds the production image from source; the override + base do the rest.
docker compose -f docker-compose.yml -f docker-compose.client.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.client.yml logs -f app   # watch first boot
```

## Option B — device is offline (carry a pre-built bundle)

On a machine **with** internet + this repo:

```bash
./scripts/build-onprem-bundle.sh     # → dist-onprem/  (images tarball + compose + .env + INSTALL.txt)
```

Copy the `dist-onprem/` folder to the device (USB / share), then on the device:

```bash
docker load < cashvan-images.tar.gz
cp .env.example .env                 # then edit .env, replace every CHANGE_ME
docker compose -f docker-compose.yml -f docker-compose.client.yml up -d
```

---

## Configure the secrets (`.env`)

Replace every `CHANGE_ME` (needs `openssl`):

| Var | Command | Note |
|---|---|---|
| `DB_PASSWORD` | `openssl rand -hex 16` | Postgres password |
| `JWT_SECRET` | `openssl rand -hex 32` | login token signing |
| `JOFOTARA_KMS_KEY` | `openssl rand -hex 32` | **must be 64 hex chars** |
| `PHONE_HASH_SECRET` | `openssl rand -hex 16` | min 16 chars |

The API **refuses to boot** in production if `JWT_SECRET`, `JOFOTARA_KMS_KEY`, or
`PHONE_HASH_SECRET` are missing/short. AI keys are optional (blank = AI feature off).

## Point the app at the device

Find the device's LAN IP (`ipconfig` on Windows, `ifconfig`/`ip a` on Mac/Linux),
then in the mobile app's **Settings → server address** enter:

```
http://<device-ip>:3000/api/v1
```

First login: **admin / admin1234** — change the password after logging in.

---

## Operate

```bash
docker compose -f docker-compose.yml -f docker-compose.client.yml logs -f app     # logs
docker compose -f docker-compose.yml -f docker-compose.client.yml restart app     # restart API only
docker compose -f docker-compose.yml -f docker-compose.client.yml down            # stop (DATA KEPT)
docker compose -f docker-compose.yml -f docker-compose.client.yml down -v         # stop + WIPE the DB
```

- **Data** lives in the `cashvan_pgdata` volume and survives restarts/upgrades.
- **Migrations + the default-admin seed run automatically** on every start
  (idempotent — safe to re-run).
- **Update** = load/build a new `cashvan-api:prod` image, then `up -d` again;
  the volume (data) is untouched.
- **Backup the DB:**
  `docker exec cashvan-db pg_dump -U cashvan cashvan | gzip > backup-$(date +%F).sql.gz`
- **First boot is slower** (migrations run against an empty DB); watch `logs -f app`
  until you see the server listening on port 3000.

## Notes

- Only the API is covered here. The Next.js **dashboard** is a separate image if
  you want it on-prem too — otherwise admins can use the cloud dashboard.
- For internet-facing installs put a TLS reverse proxy (Caddy/Traefik/nginx) in
  front; the LAN-only setup above serves plain HTTP, which is fine on a trusted
  local network.
