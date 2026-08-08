# Deployment — the combined suite image

One Docker image running **ERP + backend + dashboard**, for a client on a single
on-prem box. These files live here because the backend is the repo everyone
already clones; the build itself runs one level up.

| file | what it is |
|---|---|
| `Dockerfile.suite` | 3 build chains + a shared runtime |
| `suite-entrypoint.sh` | starts all three, dies if any one dies |
| `suite.dockerignore` | **rename to `.dockerignore`** at the build root |
| `SETUP.md` | full setup, dev through deploy |
| `REQUIREMENTS.md` | what to install on a client Windows desktop |
| `windows-preflight.ps1` | read-only check of a client machine |
| `windows-server-install.ps1` | installs what the preflight found missing |
| `caddy/` | HTTPS reverse proxy |

## Building

The image needs all three projects, so it builds from the **parent** directory —
the one holding `ERP`, `cash-van-dashboard` and `cash-van-dashboard-frontend`
side by side:

```
7Software/
├── ERP/
├── cash-van-dashboard/          <- you are here, in deploy/
├── cash-van-dashboard-frontend/
├── Dockerfile.suite             <- copied up
├── suite-entrypoint.sh          <- copied up
└── .dockerignore                <- copied up, renamed
```

```bash
cd /path/to/7Software
cp cash-van-dashboard/deploy/Dockerfile.suite     .
cp cash-van-dashboard/deploy/suite-entrypoint.sh  .
cp cash-van-dashboard/deploy/suite.dockerignore   .dockerignore
docker build --platform linux/amd64 -f Dockerfile.suite -t vanflow-suite:latest .
```

`--platform linux/amd64` is not optional when building on an Apple Silicon Mac.
Without it you get an arm64 image, which Docker will happily run on an amd64
Windows server **under QEMU emulation** — everything works, several times slower,
and nothing warns you beyond one line at `docker run`.

## Two ports, two databases, one gotcha each

`NEXT_PUBLIC_*` values are compiled into the dashboard's browser bundle at
**build** time. Changing the API URL means rebuilding the image, not restarting
it. The Google Maps key is the exception — it is baked as a placeholder and
substituted by the entrypoint, so one image can ship to clients with different
keys.

The ERP reads `DATABASE_URL`; the backend reads discrete `DB_HOST` / `DB_NAME` /
`DB_USERNAME` / `DB_PASSWORD`. Setting only one used to be silent: the backend
fell back to `localhost`/`cashvan`, booted cleanly, and failed every request. The
entrypoint now refuses to start unless all six are present.

## Caddy — HTTPS

Two variants, same hardening. Pick one, save it as `Caddyfile`, put it next to
`docker-compose.yml`.

- **`Caddyfile.sslip`** — uses `sslip.io`, which resolves `<anything>.<ip>.sslip.io`
  to that IP. Real Let's Encrypt certificates with no DNS to own. The hostname
  *contains* the IP, so a changed public IP means new hostnames, a new
  certificate, and a dashboard rebuild.
- **`Caddyfile.domain`** — proper A records. Stable names, survives an IP change,
  needs DNS configured first.

Both keep the ERP and dashboard **LAN-only** and expose only the API publicly,
because the vans are in the field and nothing else needs to be. Edit the office
subnet in the `(office_only)` block before deploying — staff get a 403 on their
own ERP if it is wrong.

Forward **only 80 and 443** at the router. Port 80 is required for the ACME
challenge; without it Caddy cannot get a certificate. **Never forward 5432.**

## Secrets

`caddy/.env.example` is a template. The real file is not in this repo and must
not be — copy it, fill it in on the server, and keep it there.

Two of those values can never be rotated once the system has data:

- `PHONE_HASH_SECRET` — changing it orphans every stored phone hash
- `JOFOTARA_KMS_KEY` — changing it makes the stored ERP API key undecryptable

The rest (`JWT_SECRET`, `SESSION_SECRET`, `PDA_TOKEN_SECRET`,
`VANFLOW_WEBHOOK_SECRET`) can and should be rotated. Rotating `JWT_SECRET` logs
everyone out, which is the intended effect.

## Migrations do not run on container start

Deliberate — an automatic migration on a restart loop will destroy a database.
Run them before first start and after every upgrade. Both databases, separately:

```bash
# backend (TypeORM) — from inside the container, against compiled JS
docker exec vanflow sh -c 'cd /srv/backend && npx typeorm migration:run -d dist/database/data-source.js'
```

```bash
# ERP (Drizzle) — the image has no drizzle-kit, so a bootstrap SQL file
# is generated from the migrations: ERP/scripts/sql/bootstrap-schema.sql
psql -U postgres -d erp_flowvan -f bootstrap-schema.sql
```

The bootstrap file records each migration's hash in `drizzle.__drizzle_migrations`
as it goes, so a later `db:migrate` on a machine that *does* have drizzle-kit
picks up from the right place instead of replaying all 105.
