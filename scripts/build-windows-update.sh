#!/usr/bin/env bash
# Build an UPDATE bundle for a Windows device that is ALREADY RUNNING VanFlow.
#
# Difference from build-windows-bundle.sh (the first-install bundle): this ships
# ONLY the two application images. No Postgres, no init-db.sql, and — deliberately
# — no docker-compose.yml.
#
#   * Postgres is already loaded on the device and its volume holds the live data.
#     Re-shipping it adds ~100 MB to the transfer and buys nothing.
#   * The device's compose file has been EDITED for that site (shared ERP network,
#     Google Maps key, ports). Overwriting it during an update is how a working
#     install gets broken, so the bundle carries instructions instead of a file.
#
# Schema changes travel inside the API image: the container's start:deploy runs
# `migration:run` before booting, so `docker compose up -d` migrates the existing
# database in place. Nothing is dropped and no volume is touched.
#
#   ./scripts/build-windows-update.sh
#
# Output: dist-windows-update/
#     vanflow-update.tar.gz   # API + dashboard, linux/amd64
#     UPDATE.txt              # the steps to run on the device
#     DANGER-reset/           # the transaction-wipe scripts, nothing runs them
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

PLATFORM="${PLATFORM:-linux/amd64}"
FRONTEND_DIR="${FRONTEND_DIR:-../cash-van-dashboard-frontend}"
API_IMAGE="cashvan-api:prod"
WEB_IMAGE="vanflow-dashboard:prod"
OUT="dist-windows-update"

# NEXT_PUBLIC_* are inlined into the browser bundle at BUILD time. They must match
# the address the device is reached at, or the dashboard calls an API that is not
# there — .env on the device cannot fix it afterwards.
#
# DEFAULT IS RELATIVE (host-agnostic). The dashboard calls "/api/v1" and opens the
# websocket on the same origin it was served from, so ONE image works on every
# client behind a reverse proxy (Caddy) that serves the dashboard and API from one
# HTTPS origin — no per-client rebuild, and no mixed-content when served over TLS.
#
# Only override for a device reached DIRECTLY on an ip:port with no proxy:
#   NEXT_PUBLIC_API_BASE_URL=http://<ip>:3002/api/v1 NEXT_PUBLIC_WS_URL=http://<ip>:3002 ./scripts/build-windows-update.sh
#
# NOTE the operators below: ":-" would treat an explicit empty value as unset and
# fall back to the default, which silently reverted a relative build to an absolute
# one once. WS uses "-" (not ":-") so an explicit empty WS is honoured.
NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-/api/v1}"
NEXT_PUBLIC_WS_URL="${NEXT_PUBLIC_WS_URL-}"
NEXT_PUBLIC_AI_ENABLED="${NEXT_PUBLIC_AI_ENABLED:-false}"
NEXT_PUBLIC_DEFAULT_LOCALE="${NEXT_PUBLIC_DEFAULT_LOCALE:-ar}"
# Placeholder, not a real key: the entrypoint substitutes GOOGLE_MAPS_API_KEY at
# container start, so the site's key stays in its compose file and never has to be
# rebuilt in. Passing an empty string here would bake in an empty key and leave
# the entrypoint nothing to replace.
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY="${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY:-__RUNTIME_GOOGLE_MAPS_API_KEY__}"

if [ ! -f "$FRONTEND_DIR/Dockerfile" ]; then
  echo "ERROR: no Dockerfile at $FRONTEND_DIR — set FRONTEND_DIR to the dashboard repo." >&2
  exit 1
fi

echo "==> Platform: $PLATFORM (host: $(uname -m))"
echo "==> Dashboard will call: $NEXT_PUBLIC_API_BASE_URL"

echo "==> Building API image ($API_IMAGE) ..."
docker buildx build --platform "$PLATFORM" --target production -t "$API_IMAGE" --load .

# The production image must start with `node dist/main.js`. A build that leaks
# scripts/ into the TS program shifts rootDir and moves the output to dist/src/,
# which crash-loops on the device with "Cannot find module /app/dist/main.js".
# That shipped once; check it here rather than on the client's server.
echo "==> Verifying the API image's entrypoint layout ..."
docker run --rm --entrypoint node "$API_IMAGE" \
  -e "require('fs').accessSync('/app/dist/main.js'); require('fs').accessSync('/app/dist/database/data-source.js')" \
  || { echo "ERROR: $API_IMAGE has no dist/main.js + dist/database/data-source.js — check tsconfig.build.json excludes." >&2; exit 1; }

echo "==> Building dashboard image ($WEB_IMAGE) ..."
docker buildx build --platform "$PLATFORM" -t "$WEB_IMAGE" --load \
  --build-arg "NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL" \
  --build-arg "NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL" \
  --build-arg "NEXT_PUBLIC_AI_ENABLED=$NEXT_PUBLIC_AI_ENABLED" \
  --build-arg "NEXT_PUBLIC_DEFAULT_LOCALE=$NEXT_PUBLIC_DEFAULT_LOCALE" \
  --build-arg "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY" \
  "$FRONTEND_DIR"

if [ "$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY" = "__RUNTIME_GOOGLE_MAPS_API_KEY__" ]; then
  echo "==> Verifying the Maps-key placeholder landed in $WEB_IMAGE ..."
  if ! docker run --rm --entrypoint sh "$WEB_IMAGE" \
        -c 'grep -rq "__RUNTIME_GOOGLE_MAPS_API_KEY__" .next/static' 2>/dev/null; then
    echo "ERROR: placeholder token not found in $WEB_IMAGE's .next/static — the" >&2
    echo "       runtime Google Maps key substitution will not work for this build." >&2
    exit 1
  fi
fi

# Per-platform inspect: with the containerd image store a multi-arch tag keeps the
# whole OCI index, so a bare inspect reports "/" and proves nothing.
echo "==> Verifying every image has a $PLATFORM variant ..."
for img in "$API_IMAGE" "$WEB_IMAGE"; do
  arch="$(docker image inspect "$img" --platform "$PLATFORM" \
            --format '{{.Os}}/{{.Architecture}}')" \
    || { echo "ERROR: $img has no $PLATFORM variant" >&2; exit 1; }
  echo "    $img -> $arch"
  [ "$arch" = "$PLATFORM" ] || { echo "ERROR: $img is $arch, expected $PLATFORM" >&2; exit 1; }
done

echo "==> Saving images to a compressed tarball ..."
# Remove only what THIS script generates. `rm -rf "$OUT"` used to wipe the whole
# folder — and that folder is where the site's own docker-compose.yml, Caddyfile,
# INSTALL.txt and .env (real secrets) are kept between builds. dist-windows-update/
# is gitignored, so there was no copy anywhere: one build erased the lot.
mkdir -p "$OUT"
rm -f "$OUT/vanflow-update.tar.gz" "$OUT/UPDATE.txt"
rm -rf "$OUT/DANGER-reset"
docker save --platform "$PLATFORM" "$API_IMAGE" "$WEB_IMAGE" \
  | gzip > "$OUT/vanflow-update.tar.gz"

# The data-wipe scripts travel with the bundle because they are asked for in the
# same breath as the update, but they are NOT part of it: nothing above or below
# runs them, and the folder name is the warning.
ERP_RESET="${ERP_RESET:-../ERP/scripts/sql/reset-sales-transactions.sql}"
mkdir -p "$OUT/DANGER-reset"
cp scripts/sql/reset-transactions.sql "$OUT/DANGER-reset/cashvan-reset-transactions.sql"
if [ -f "$ERP_RESET" ]; then
  cp "$ERP_RESET" "$OUT/DANGER-reset/erp-reset-sales-transactions.sql"
else
  echo "    note: no ERP reset script at $ERP_RESET — bundling the cash-van one only"
fi

cat > "$OUT/UPDATE.txt" <<TXT
VanFlow — UPDATE for a device that is already running (Windows / Docker Desktop)
===============================================================================
This tarball contains ONLY the application images:
    cashvan-api:prod
    vanflow-dashboard:prod
Postgres is not included and your database volume is not touched. Nothing here
deletes data.

BEFORE YOU START — one edit that is REQUIRED
--------------------------------------------
If your docker-compose.yml still carries the temporary override added to work
around the old crash loop — anything mentioning dist/src — REPLACE it with:

    command: ["npm", "run", "start:deploy"]

This build puts the compiled output back at dist/ (not dist/src/), so the old
override points at files that no longer exist and the API crash-loops on start.

Do NOT simply delete the line. The image's own default command is
'node dist/main.js', which starts the server but SKIPS MIGRATIONS — the API
would come up against an un-migrated database and fail on missing columns.
start:deploy is what runs migrate -> seed -> start.

STEPS
-----
1) Copy vanflow-update.tar.gz to the device, into the folder that holds
   docker-compose.yml.

2) Back up the database first (30 seconds, and it is the only undo):
     docker exec cashvan-db pg_dump -U cashvan cashvan > backup-before-update.sql

3) Load the new images:
     docker load -i vanflow-update.tar.gz

4) Recreate the two containers (the database container is left alone):
     docker compose up -d --force-recreate app dashboard

   --force-recreate matters: without it Compose may keep the running containers
   because the compose file did not change, and you would still be on the old
   build. It also gives the dashboard a fresh container, which is what lets the
   entrypoint substitute GOOGLE_MAPS_API_KEY into the bundle.

5) Watch the API come up — migrations run here, before it starts listening:
     docker compose logs -f app
   Wait for "Nest application successfully started".

6) Check (from inside the container, so the published port does not matter —
   this compose publishes 3100, an older one published 3002):
     docker compose exec app wget -qO- http://localhost:3000/api/v1/health
   Then open the dashboard and press Ctrl+F5 (a hard reload). The old browser
   cache holds the previous JavaScript and will otherwise hide the update.

IF SOMETHING IS WRONG
---------------------
     docker compose logs --tail=100 app
The previous images are still on the device until you prune, so a rollback is
retagging the old image id and running 'docker compose up -d' again. Restoring
the .sql backup is only needed if a migration is the problem.

NEVER RUN
---------
     docker compose down -v      <- the -v DELETES the database volume.
Plain 'docker compose down' is safe.

The dashboard's API address is baked in at build time:
     $NEXT_PUBLIC_API_BASE_URL
If the device is reached at a different address, the dashboard has to be rebuilt
with that address — editing .env on the device will not change it.

DANGER-reset\\  — NOT part of the update
-----------------------------------------
Two scripts that ERASE every transaction (invoices, payments, collections,
customer debt) while keeping customers, items and users. They are here because
they were asked for alongside this update; the update itself does not touch any
data. Read the header of each file before running either, back up first, and
stop the services while they run.

     cashvan-reset-transactions.sql       -> cashvan-db  / database "cashvan"
     erp-reset-sales-transactions.sql     -> erp-db      / database "erp_database"

Run them the same way, one at a time:
     docker cp DANGER-reset\\cashvan-reset-transactions.sql cashvan-db:/tmp/r.sql
     docker exec cashvan-db psql -U cashvan -d cashvan -f /tmp/r.sql
TXT

echo "==> Done. Update bundle ready in: $OUT/"
du -sh "$OUT/vanflow-update.tar.gz" 2>/dev/null || true
