# Update the 94 client — 94.142.51.91 (Windows / Docker Desktop)

VanFlow dashboard + API: **https://94.142.51.91.sslip.io**
ERP (untouched by this update): https://erp.94.142.51.91.sslip.io

The images are Linux containers (Docker Desktop runs them on WSL2), so the
`dist-94/*.tar.gz` built on the Mac are correct as-is — no Windows-specific
rebuild. All commands below are **PowerShell on the 94 server**.

**Three silent traps** (each reports success while nothing changed):
1. The image **tag must match what compose expects** — otherwise `up -d` prints
   `Running` and keeps the old image.
2. **Migrations don't self-run** — the image starts `node dist/main` against the
   old schema. This release adds the segment tables; skip the migration and every
   `/segments` call 500s and some others fail.
3. **PowerShell mangles JSON** — use single quotes for `-Body`, never `\"` escapes.

---

## 0. Get the two images onto the server

Copy from the Mac's `cash-van-dashboard/dist-94/` to the 94 server (USB / network
share / scp), into the folder that holds the compose file (referred to below as
`D:\7Software\cashvan` — adjust to the real path):

- `cashvan-api-prod.tar.gz`
- `cashvan-dashboard-prod.tar.gz`

## 1. Back up the database first

```powershell
cd D:\7Software\cashvan
docker exec cashvan-db pg_dump -U cashvan -Fc cashvan -f /tmp/pre-upgrade.dump
docker cp cashvan-db:/tmp/pre-upgrade.dump D:\7Software\cashvan\pre-upgrade.dump
```
(Never redirect `pg_dump` with `>` in PowerShell — it corrupts the file. The
container `/tmp` is wiped on recreate, so copying it out is the point.)

## 2. Load the images

```powershell
docker load -i .\cashvan-api-prod.tar.gz
docker load -i .\cashvan-dashboard-prod.tar.gz
```

## 3. Check the tags compose actually uses

```powershell
docker ps --format "table {{.Names}}`t{{.Image}}"
```
Note the API and dashboard container names and their `IMAGE` tags.

## 4. Retag the loaded images to match compose (BEFORE any `up`)

The tarballs load as `cashvan-api:prod` and `cashvan-dashboard:prod`. If compose
expects different tags (on the sister client the dashboard runs
`vanflow-dashboard:prod`), retag to whatever step 3 showed, e.g.:

```powershell
docker tag cashvan-dashboard:prod vanflow-dashboard:prod
# docker tag cashvan-api:prod <the-tag-compose-uses>   # if the API tag differs too
```

## 5. Recreate the API

```powershell
docker compose up -d --force-recreate app
```

## 6. Run migrations by hand — REQUIRED

Creates `customer_segments`, `segment_customers`, `segment_reps` (and any other
pending). Watch for `COMMIT`.

```powershell
docker exec cashvan-api npm run migration:run:prod
```
(Container name is whatever step 3 showed for the API — commonly `cashvan-api`.)

## 7. Restart the API so it picks up the new schema

```powershell
docker compose restart app
```

## 8. Recreate the dashboard

```powershell
docker compose up -d --force-recreate dashboard
```
Expect `Started` / `Recreated`. If it says `Running`, step 4 didn't take.

## 9. Verify

```powershell
# API login through the public origin
Invoke-RestMethod -Uri https://94.142.51.91.sslip.io/api/v1/auth/login -Method Post `
  -ContentType 'application/json' -Body '{"userNumber":"admin","password":"admin1234"}'

# Confirm the NEW dashboard bundle is live (segments is new this release)
docker exec vanflow-dashboard sh -c "grep -rl segments .next/static | head -1"
```
A filename from the grep = new bundle live. Then open
**https://94.142.51.91.sslip.io**, and check **الشرائح (Segments)** appears under
Operations and the page loads.

## Rollback (if needed)

```powershell
# restore the DB dump taken in step 1
docker cp D:\7Software\cashvan\pre-upgrade.dump cashvan-db:/tmp/pre-upgrade.dump
docker exec cashvan-db pg_restore -U cashvan -d cashvan --clean --if-exists /tmp/pre-upgrade.dump
# then re-tag/redeploy the previous image if you kept it
```

---

## What this release adds
- **Customer segmentation** (phases 1–4): segments, offers targeted at a segment,
  dynamic rule-based segments, and per-segment sales analytics + rep linking.
- Plus earlier: customer↔salesman Excel import, the Devices page, and full-catalog
  item pickers.

Caddy config and the ERP are unchanged on this server.
