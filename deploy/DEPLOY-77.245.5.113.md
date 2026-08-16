# Deploying to the client servers (77.245.5.113 and 94.142.51.91)

The steps below are written for the new client, **77.245.5.113**. The same two
images deploy to **94.142.51.91** unchanged — only the Caddyfile and the
hostnames differ (see §3 and the second table below).

Two things ship together here, and they have to ship together:

1. **A current API image.** The build running on that server predates the stock
   request feature — `GET /api/v1/stock-requests` returns 404 and the user
   payload has no `canRequestStock` / `canApproveStockRequest`.
2. **HTTPS for the dashboard.** VanFlow is reachable only as
   `http://77.245.5.113:3001` today, so every admin password crosses the
   internet in clear text. This is a new client server, set up from the config
   of the existing client at `94.142.51.91`; sslip.io hostnames *are* the IP,
   so those hostnames name the other machine and match nothing here.
   Each client needs its own Caddyfile — but only that. Both images below are
   host-agnostic and deploy unchanged to either server.

They ship together because the dashboard bundle had
`http://77.245.5.113:3002/api/v1` compiled into it. Serve that page over HTTPS
without rebuilding and every API call is blocked as mixed content — the login
screen would render and then fail on submit. The new dashboard image is built
with **relative** URLs (`/api/v1`), so it calls whatever host it was loaded
from and never needs rebuilding again when the address changes.

## What changes

| | before | after |
|---|---|---|
| ERP | `https://77.245.5.113.sslip.io` | unchanged |
| Dashboard | `http://77.245.5.113:3001` | `https://app.77.245.5.113.sslip.io` |
| API | `http://77.245.5.113:3002/api/v1` | `https://app.77.245.5.113.sslip.io/api/v1` |
| Cookie | `SameSite=Lax`, not Secure | `SameSite=Lax`, **Secure** |

The ERP keeps the hostname it already answers on, so nothing there breaks.
VanFlow takes its own subdomain. Dashboard and API share one origin, which is
what removes CORS entirely and lets the auth cookie be marked `Secure`.

### On 94.142.51.91, the hostnames do not change at all

That server already serves VanFlow and its API from one origin over HTTPS, so
there is nothing to move — its Caddyfile keeps every hostname exactly as it is:

| | before | after |
|---|---|---|
| VanFlow + API | `https://94.142.51.91.sslip.io` | unchanged |
| ERP | `https://erp.94.142.51.91.sslip.io` | unchanged |
| Security headers | **none sent at all** | HSTS, `X-Frame-Options`, `nosniff`, referrer policy |
| `/storage/*` | not routed — photo previews 404 | routed to the backend |
| Unknown `Host` | served the first site defined | 404 |

So on that machine this is a hardening pass plus the new images, not a move.
Its dashboard currently runs a bundle with an absolute URL patched into it;
replacing it with the relative-URL image removes that fragility too.

---

## 1. Load the images (PowerShell, on the server)

`docker load` reads the gzip directly — do not decompress first.

```powershell
cd D:\system\7software\dist-new-customer
docker load -i .\cashvan-api-prod.tar.gz
docker load -i .\cashvan-dashboard-prod.tar.gz
docker images | Select-String cashvan
```

Both should list as `prod`.

The same two tarballs deploy to **either** client — they carry no hostname.
Only the Caddyfile is per-client. The ERP is not shipped here at all; it keeps
whatever image it is already running and is only routed to.

## 2. Confirm the service names and image tags

The Caddyfile proxies to `app:3000`, `dashboard:3000` and `erp-app:3000`.
Those are Docker **service names**, resolved on the shared network — check they
match what is actually running before reloading Caddy:

```powershell
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}"
```

If a name differs, edit the `reverse_proxy` lines to match rather than renaming
containers.

Check the same output's `IMAGE` column against the tags you just loaded
(`cashvan-api:prod`, `cashvan-dashboard:prod`). If the compose file names a
different tag, `docker compose up -d` will happily restart the **old** image
and nothing will appear to change — the single most common way this deploy
looks like it worked when it did not. Update the `image:` lines to match, or
retag the loaded images to whatever compose already expects:

```powershell
docker tag cashvan-api:prod <the-tag-compose-uses>
```

## 3. Install the Caddyfile

Pick the file for the client you are on — **the two are not interchangeable**:

| server | file | VanFlow | ERP |
|---|---|---|---|
| 77.245.5.113 | `deploy/caddy/Caddyfile.client-77.245.5.113` | `app.*` | bare hostname |
| 94.142.51.91 | `deploy/caddy/Caddyfile.client-94.142.51.91` | bare hostname | `erp.*` |

The two clients are mirror images of each other, because each keeps the layout
it already serves — swapping them would break every saved bookmark and point
the handsets at the wrong app.

Copy it to the server as the Caddy config (the path the caddy container mounts
— typically `.\Caddyfile` beside its compose file). Then validate **before**
reloading, so a typo doesn't take the ERP down with it:

```powershell
docker exec erp-caddy caddy validate --config /etc/caddy/Caddyfile
```

Only if that prints `Valid configuration`:

```powershell
docker exec erp-caddy caddy reload --config /etc/caddy/Caddyfile
```

On 77.245.5.113, Caddy requests a certificate for `app.77.245.5.113.sslip.io`
on first request. **Ports 80 and 443 must both be open to the internet** —
Let's Encrypt connects back on port 80 and will not issue a certificate if it
cannot reach the server. On 94.142.51.91 no new hostname is introduced, so the
existing certificates are reused and nothing is requested.

## 4. Point the API's cookie at HTTPS

In the API's `.env`:

```
COOKIE_SAMESITE=lax
COOKIE_SECURE=true
```

`lax` is correct now that the dashboard and API share an origin, and it is
safer than `none`. `Secure` is what stops the session cookie from ever being
sent over plain HTTP. This does not affect the phones — mobile clients
authenticate with `Authorization: Bearer`, not the cookie.

## 5. Recreate the containers

`up -d` recreates from the newly loaded images. The API's `start:deploy`
command runs the 85 migrations and the idempotent seed on boot, so there is no
separate migration step.

```powershell
docker compose up -d
docker compose logs -f app
```

Watch for the migrations to finish before moving on.

---

## 6. Verify

```powershell
curl.exe -i https://app.77.245.5.113.sslip.io/api/v1/health
```

Expect `{"status":"ok","db":"up"}` — the cash van API. (If you see
`{"status":"ok","version":"v1"}` that is the *ERP's* API answering, which means
the hostname routed to the wrong app.)

Then confirm the feature that was missing is now live — 401 is the right
answer here, it means the route exists and is protected:

```powershell
curl.exe -i https://app.77.245.5.113.sslip.io/api/v1/stock-requests
```

And log in at `https://app.77.245.5.113.sslip.io` with `admin` / `admin1234`.

On 94.142.51.91 run the same three checks against `https://94.142.51.91.sslip.io`
(no `app.` prefix), and confirm the ERP still answers on
`https://erp.94.142.51.91.sslip.io`. One extra check there, since that server
had no security headers before:

```powershell
curl.exe -sI https://94.142.51.91.sslip.io/ | Select-String -Pattern "strict-transport|x-frame"
```

---

## 7. Close the bypass — after the phones are moved

Until the mobile app is rebuilt to use `https://app.77.245.5.113.sslip.io/api/v1`,
port 3002 must stay reachable or the vans stop syncing. Once they are moved,
that port is a hole straight past TLS: anyone who knows the IP can still reach
the API in clear text on `http://77.245.5.113:3002`, cookie and all.

Close it by binding the published ports to localhost in the compose file —
`"127.0.0.1:3002:3000"` and `"127.0.0.1:3001:3000"` — so only Caddy can reach
them, and forward only 80 and 443 on the router.

Port 5432 must never be forwarded to the internet.
