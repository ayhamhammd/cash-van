#!/usr/bin/env bash
# Build an OFFLINE install bundle for a WINDOWS device (Docker Desktop).
#
# Unlike build-onprem-bundle.sh (API + Postgres, host architecture) this ships the
# full stack — API + Next.js dashboard + Postgres — and force-builds every image
# for linux/amd64, which is what Docker Desktop on Windows runs. Building on an
# Apple Silicon Mac WITHOUT this pin produces arm64 images that will not start on
# Windows, so the platform pin is the whole point of this script.
#
# Cross-building amd64 on arm64 runs under QEMU emulation and is SLOW (the Next.js
# build especially) — expect 10-30 minutes. Native amd64 hosts build normally.
#
#   ./scripts/build-windows-bundle.sh
#
# Output: dist-windows/
#     vanflow-images.tar.gz      # API + dashboard + Postgres, all linux/amd64
#     docker-compose.yml         # self-contained: no build steps, images only
#     .env.example               # rename to .env and fill in on the device
#     scripts/init-db.sql
#     INSTALL.txt
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

PLATFORM="${PLATFORM:-linux/amd64}"
FRONTEND_DIR="${FRONTEND_DIR:-../cash-van-dashboard-frontend}"
PG_IMAGE="postgres:16.4-alpine"
API_IMAGE="cashvan-api:prod"
WEB_IMAGE="vanflow-dashboard:prod"
OUT="dist-windows"

# NEXT_PUBLIC_* are inlined into the browser bundle at BUILD time — changing them
# needs a rebuild, not a restart. These default to the layout the compose file
# below exposes: dashboard on host :3001, API on host :3002.
API_ORIGIN="${API_ORIGIN:-http://77.245.5.113:3002}"
NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-${API_ORIGIN}/api/v1}"
NEXT_PUBLIC_WS_URL="${NEXT_PUBLIC_WS_URL:-${API_ORIGIN}}"
NEXT_PUBLIC_AI_ENABLED="${NEXT_PUBLIC_AI_ENABLED:-false}"
NEXT_PUBLIC_DEFAULT_LOCALE="${NEXT_PUBLIC_DEFAULT_LOCALE:-ar}"
# Defaults to the placeholder token (matching the Dockerfile's own ARG default) so
# the entrypoint script has something to substitute at container start — passing
# an empty string here would override that default and bake in an empty key,
# permanently defeating the whole point of the runtime-injection mechanism.
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY="${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY:-__RUNTIME_GOOGLE_MAPS_API_KEY__}"

if [ ! -f "$FRONTEND_DIR/Dockerfile" ]; then
  echo "ERROR: no Dockerfile at $FRONTEND_DIR — set FRONTEND_DIR to the dashboard repo." >&2
  exit 1
fi

echo "==> Platform: $PLATFORM (host: $(uname -m))"
echo "==> Dashboard will call: $NEXT_PUBLIC_API_BASE_URL"

echo "==> Building API image ($API_IMAGE) ..."
docker buildx build --platform "$PLATFORM" --target production -t "$API_IMAGE" --load .

echo "==> Building dashboard image ($WEB_IMAGE) ..."
docker buildx build --platform "$PLATFORM" -t "$WEB_IMAGE" --load \
  --build-arg "NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL" \
  --build-arg "NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL" \
  --build-arg "NEXT_PUBLIC_AI_ENABLED=$NEXT_PUBLIC_AI_ENABLED" \
  --build-arg "NEXT_PUBLIC_DEFAULT_LOCALE=$NEXT_PUBLIC_DEFAULT_LOCALE" \
  --build-arg "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY" \
  "$FRONTEND_DIR"

# Guard against silently baking in an empty/wrong Maps key: when this script is
# using the placeholder default (no real key explicitly requested), confirm the
# placeholder token actually landed in the built image's static files — that's
# what docker-entrypoint.sh substitutes at container start. A mismatch here
# previously shipped an image with an empty key baked in and nothing for the
# entrypoint to replace, which only surfaced as a silent runtime bug days later.
if [ "$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY" = "__RUNTIME_GOOGLE_MAPS_API_KEY__" ]; then
  echo "==> Verifying the Maps-key placeholder landed in $WEB_IMAGE ..."
  if ! docker run --rm --entrypoint sh "$WEB_IMAGE" \
        -c 'grep -rq "__RUNTIME_GOOGLE_MAPS_API_KEY__" .next/static' 2>/dev/null; then
    echo "ERROR: placeholder token not found in $WEB_IMAGE's .next/static — the" >&2
    echo "       runtime Google Maps key substitution will not work for this build." >&2
    exit 1
  fi
fi

echo "==> Pulling Postgres image ($PG_IMAGE, $PLATFORM) ..."
docker pull --platform "$PLATFORM" "$PG_IMAGE"

# Verify per-platform. With Docker's containerd image store a pulled multi-arch tag
# keeps the whole OCI index, so top-level .Os/.Architecture are EMPTY — inspecting
# without --platform reports "/" and tells you nothing. --platform also makes the
# command fail outright when the requested arch is absent, which is the check we want.
echo "==> Verifying every image has a $PLATFORM variant ..."
for img in "$API_IMAGE" "$WEB_IMAGE" "$PG_IMAGE"; do
  arch="$(docker image inspect "$img" --platform "$PLATFORM" \
            --format '{{.Os}}/{{.Architecture}}')" \
    || { echo "ERROR: $img has no $PLATFORM variant" >&2; exit 1; }
  echo "    $img -> $arch"
  [ "$arch" = "$PLATFORM" ] || { echo "ERROR: $img is $arch, expected $PLATFORM" >&2; exit 1; }
done

# --platform on save matters for the same reason: a multi-arch index would otherwise
# put every architecture in the tarball (or the wrong one on the device).
echo "==> Saving images to a compressed tarball ..."
rm -rf "$OUT" && mkdir -p "$OUT/scripts"
docker save --platform "$PLATFORM" "$API_IMAGE" "$WEB_IMAGE" "$PG_IMAGE" \
  | gzip > "$OUT/vanflow-images.tar.gz"

cp .env.client.example  "$OUT/.env.example"
cp scripts/init-db.sql  "$OUT/scripts/init-db.sql"

# Self-contained compose: images only, no build context needed on the device.
# Ports mirror the live client server — dashboard :3001, API :3002 — so the URL
# baked into the dashboard bundle resolves to the API in this same stack.
cat > "$OUT/docker-compose.yml" <<'YML'
services:
  db:
    image: postgres:16.4-alpine
    container_name: cashvan-db
    environment:
      POSTGRES_USER: ${DB_USERNAME:-cashvan}
      POSTGRES_PASSWORD: ${DB_PASSWORD:?set DB_PASSWORD in .env}
      POSTGRES_DB: ${DB_NAME:-cashvan}
    volumes:
      - cashvan_pgdata:/var/lib/postgresql/data
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/00-init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USERNAME:-cashvan} -d ${DB_NAME:-cashvan}"]
      interval: 5s
      # 10s, not 3s: pg_isready on a loaded Windows host can take longer than
      # three seconds to answer, and a failed probe stops the API starting at
      # all — a slow database was being reported as a dead one.
      timeout: 10s
      retries: 10
    networks: [cashvan-net]
    restart: always

  app:
    image: cashvan-api:prod
    container_name: cashvan-api
    env_file: [.env]
    environment:
      - NODE_ENV=production
      - DB_HOST=db
    # migrate -> seed (idempotent) -> start. No manual migration step.
    command: ["npm", "run", "start:deploy"]
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "3002:3000"
    volumes:
      - cashvan_storage:/app/storage
    networks: [cashvan-net]
    restart: always

  dashboard:
    image: vanflow-dashboard:prod
    container_name: vanflow-dashboard
    environment:
      NODE_ENV: production
    depends_on: [app]
    # No published port: this stack's own reverse proxy (Caddy or similar) is the
    # public entry point and reaches this container over the internal network by
    # its service name ("dashboard"). Publishing 3001 here collides with that
    # proxy if one is already bound to it — only add ports if you are SURE nothing
    # else fronts this dashboard.
    networks: [cashvan-net]
    restart: always

volumes:
  cashvan_pgdata:
  cashvan_storage:

networks:
  cashvan-net:
    # driver: bridge  -- correct ONLY when this stack owns the network alone.
    #
    # On a device that also runs the ERP behind a shared Caddy proxy, the network
    # already exists and other containers live on it. Compose then tries to
    # DELETE and recreate it on every `up`, fails with "network has active
    # endpoints", and the whole stack refuses to start. Swap the two lines below
    # for that layout so Compose ATTACHES instead of managing the lifecycle:
    #
    #   name: cashvan_cashvan-net
    #   external: true
    #
    # Do not `docker network rm` the shared network to get out of it — that
    # disconnects the ERP and the proxy along with this stack.
    driver: bridge
YML

cat > "$OUT/INSTALL.txt" <<TXT
VanFlow — offline install for Windows (Docker Desktop)
======================================================
Images are linux/amd64. Docker Desktop must be in LINUX CONTAINERS mode
(the default; the Docker tray icon menu says "Switch to Windows containers..."
when you are already in Linux mode -- do NOT switch).

1) Load the images (no internet needed):
     docker load -i vanflow-images.tar.gz

2) Configure secrets:
     copy .env.example .env
   Then edit .env and replace every CHANGE_ME. In PowerShell:
     -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })   # 64 hex chars
   JWT_SECRET and JOFOTARA_KMS_KEY need 64 hex chars; DB_PASSWORD and
   PHONE_HASH_SECRET need at least 16. The API refuses to boot without them.

3) Start:
     docker compose up -d
     docker compose logs -f app        # watch first boot (migrations run here)

4) Open:
     Dashboard  http://localhost:3001
     API        http://localhost:3002/api/v1
   Default login: admin / admin1234  (change it after first login).

   The vans' phones point at:  http://<this-device-ip>:3002/api/v1
   (find the IP with 'ipconfig')

IMPORTANT — the dashboard's API URL is baked in at BUILD time:
     $NEXT_PUBLIC_API_BASE_URL
If the device is reached at a different address, the dashboard must be REBUILT
with the new URL (scripts/build-windows-bundle.sh, API_ORIGIN=...). Editing .env
on the device will NOT change it.

Stop:    docker compose down          (keeps data)
Wipe:    docker compose down -v       (DELETES the database)
Backup:  docker exec cashvan-db pg_dump -U cashvan cashvan > backup.sql
Update:  docker load -i <new tarball> ; docker compose up -d

SHARED-NETWORK DEVICES (this stack alongside the ERP / a Caddy proxy)
   If `docker compose up -d` fails with
       network cashvan_cashvan-net has active endpoints
   the network is shared and Compose must not try to recreate it. In
   docker-compose.yml replace:
       networks:
         cashvan-net:
           driver: bridge
   with:
       networks:
         cashvan-net:
           name: cashvan_cashvan-net
           external: true
   then `docker compose up -d` again. Do NOT `docker network rm` it — that
   disconnects the ERP and the proxy too.
TXT

echo "==> Done. Bundle ready in: $OUT/"
du -sh "$OUT/vanflow-images.tar.gz" 2>/dev/null || true
