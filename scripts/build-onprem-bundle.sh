#!/usr/bin/env bash
# Build an OFFLINE install bundle for a client device with no internet.
#
# Run this on a machine that HAS internet + Docker + this repo. It produces one
# folder you copy to the device (USB / network share):
#
#   dist-onprem/
#     cashvan-images.tar.gz      # the API + Postgres images
#     docker-compose.client.yml
#     .env.example               # rename to .env and fill in on the device
#     scripts/init-db.sql
#     INSTALL.txt
#
# On the device (Docker installed):
#   docker load  < cashvan-images.tar.gz
#   cp .env.example .env   &&   edit .env   (set the CHANGE_ME secrets)
#   docker compose -f docker-compose.client.yml up -d
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

PG_IMAGE="postgres:16.4-alpine"
API_IMAGE="cashvan-api:prod"
OUT="dist-onprem"

echo "==> Building API image ($API_IMAGE) ..."
docker build -t "$API_IMAGE" --target production .

echo "==> Pulling Postgres image ($PG_IMAGE) ..."
docker pull "$PG_IMAGE"

echo "==> Saving images to a compressed tarball ..."
rm -rf "$OUT" && mkdir -p "$OUT/scripts"
docker save "$API_IMAGE" "$PG_IMAGE" | gzip > "$OUT/cashvan-images.tar.gz"

cp docker-compose.client.yml "$OUT/"
cp .env.client.example        "$OUT/.env.example"
cp scripts/init-db.sql        "$OUT/scripts/init-db.sql"

cat > "$OUT/INSTALL.txt" <<'TXT'
VanFlow API — offline install
==============================
Requirements on the device: Docker Desktop (Windows/Mac) or Docker Engine (Linux).

1) Load the images (no internet needed):
     docker load < cashvan-images.tar.gz

2) Configure secrets:
     cp .env.example .env
   Then edit .env and replace every CHANGE_ME using:
     openssl rand -hex 32   # JWT_SECRET and JOFOTARA_KMS_KEY (KMS must be 64 chars)
     openssl rand -hex 16   # DB_PASSWORD and PHONE_HASH_SECRET

3) Start it:
     docker compose -f docker-compose.client.yml up -d
     docker compose -f docker-compose.client.yml logs -f app   # watch first boot

4) Find the device's LAN IP (ipconfig / ifconfig) and point the mobile app's
   "server address" at:   http://<device-ip>:3000/api/v1
   Default login: admin / admin1234  (change the password after first login).

Stop:    docker compose -f docker-compose.client.yml down          (keeps data)
Update:  docker load < <new bundle> ; docker compose ... up -d     (data kept)
TXT

echo "==> Done. Bundle ready in: $OUT/"
du -sh "$OUT/cashvan-images.tar.gz" 2>/dev/null || true
