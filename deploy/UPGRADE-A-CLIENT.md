# Upgrading a client server (API + dashboard)

The procedure that worked on 77.245.5.113, written down after the fact so the
next one takes ten minutes instead of two hours. All commands are PowerShell on
the client's Windows server.

**Three things bite every time.** They are steps 4, 6 and 8 below, and each one
fails *silently* — the command reports success and nothing has changed:

1. **The image tag must match what compose expects.** `docker load` names the
   image whatever the tarball says. If compose wants a different tag, `up -d`
   compares the container against an unchanged tag, finds nothing to do, and
   prints `Running`. The word `Running` where you expected `Recreated` is the
   only warning you get.
2. **Migrations do not run on their own.** The image's default command is
   `node dist/main.js`. It starts the new code against the old schema, so the
   API comes up healthy and only *some* requests fail — login first, because it
   touches the columns the new release added.
3. **PowerShell mangles JSON and binary redirects.** `\"` escapes arrive broken,
   and `>` writes UTF-16 that `psql` cannot read back.

---

## 1. Back up the database

`-Fc` and `-f` write the dump inside the container; `docker cp` brings it out.
Never redirect `pg_dump` with `>` in PowerShell — it corrupts the file, and you
find out when you need it.

```powershell
docker exec cashvan-db pg_dump -U cashvan -Fc cashvan -f /tmp/pre-upgrade.dump
docker cp cashvan-db:/tmp/pre-upgrade.dump D:\7Software\cashvan\pre-upgrade.dump
```

Container `/tmp` is destroyed when the container is recreated, so copying it out
is the point — the dump is worthless where it lands.

## 2. Load the images

```powershell
cd D:\7Software\cashvan
docker load -i .\cashvan-api-prod.tar.gz
docker load -i .\cashvan-dashboard-prod.tar.gz
```

## 3. Read the current tags

```powershell
docker ps --format "table {{.Names}}\t{{.Image}}"
```

## 4. Retag to whatever compose already uses

Compare the `IMAGE` column against what you just loaded. On 77.245.5.113 the
dashboard runs `vanflow-dashboard:prod`, so:

```powershell
docker tag cashvan-dashboard:prod vanflow-dashboard:prod
```

Do this **before** any `up`. Retagging afterwards leaves compose still holding
the old comparison.

## 5. Recreate the API

```powershell
docker compose up -d --force-recreate app
```

## 6. Run the migrations by hand

```powershell
docker exec cashvan-api npm run migration:run:prod
```

Watch for `COMMIT` at the end. Until this runs, the new code is talking to the
old schema and login fails with `column User.<something> does not exist` in the
API log — the app itself looks perfectly healthy.

To make this automatic on future upgrades, add to the `app` service:
`command: ["npm", "run", "start:deploy"]`.

## 7. Restart the API so it sees the new schema

```powershell
docker compose restart app
```

## 8. Recreate the dashboard

```powershell
docker compose up -d --force-recreate dashboard
```

Expect **`Started`** or `Recreated`. If it says `Running`, step 4 did not take.

## 9. Verify

Use single quotes for the JSON body. Double quotes with `\"` escapes arrive at
the API as malformed JSON and it answers 400 — which looks exactly like a
broken deploy and is not one.

```powershell
Invoke-RestMethod -Uri http://localhost:3002/api/v1/auth/login -Method Post `
  -ContentType 'application/json' `
  -Body '{"userNumber":"admin","password":"admin1234"}'
```

Confirm the dashboard container really carries the new build, rather than
trusting compose's output — pick a string only the new release contains:

```powershell
docker exec vanflow-dashboard sh -c "grep -rl routes.cycle .next/static | head -1"
```

A filename means the new bundle is live. Nothing means step 4 or 8 failed.

---

## After a stock-request or route-cycle release

`canRequestStock` and `canApproveStockRequest` both default to **false**, so
nobody can raise or approve a request until they are granted per user in
Settings. The migration auto-grants `canRequestStock` to reps who already have a
van, so an existing deployment does not go quiet on upgrade.

Route cycles start at 7 days anchored to a Sunday for every rep, which is
identically the old weekday behaviour. Change it per salesman on the routes
page.

## Why the dashboard image never needs rebuilding

It is built with **relative** URLs — `NEXT_PUBLIC_API_BASE_URL=/api/v1` and an
empty `NEXT_PUBLIC_WS_URL` — so the browser calls whatever host served the page.
The same tarball works on `:3001`, on `http://<ip>/` behind Caddy, on localhost
and on the LAN, and on every client.

This matters because the previous build had `http://77.245.5.113:3002/api/v1`
compiled into it and was deployed to the *other* customer, where the browser
blocked every API call as mixed content and the login page looked broken with
nothing wrong in the logs.
