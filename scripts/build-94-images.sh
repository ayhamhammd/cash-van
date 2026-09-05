#!/usr/bin/env bash
# Build the two prod images for a Caddy-fronted Linux client (94.142.51.91 / 77),
# saved as the SEPARATE tarballs deploy/DEPLOY-77.245.5.113.md loads:
#     dist-94/cashvan-api-prod.tar.gz         (cashvan-api:prod)
#     dist-94/cashvan-dashboard-prod.tar.gz   (cashvan-dashboard:prod)
#
# The dashboard is host-agnostic: it calls a RELATIVE "/api/v1" and opens its
# websocket same-origin, so ONE image works behind Caddy on either client — no
# hostname baked in. Postgres is NOT shipped (the client already runs it).
#
# Cross-building amd64 on Apple Silicon runs under QEMU and is slow (10-30 min).
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

PLATFORM="linux/amd64"
FRONTEND_DIR="${FRONTEND_DIR:-../cash-van-dashboard-frontend}"
API_IMAGE="cashvan-api:prod"
WEB_IMAGE="cashvan-dashboard:prod"
OUT="dist-94"

# Host-agnostic dashboard bundle (relative API, same-origin WS). Maps key stays the
# runtime placeholder so docker-entrypoint.sh can substitute the real key on start.
NEXT_PUBLIC_API_BASE_URL="/api/v1"
NEXT_PUBLIC_WS_URL=""
NEXT_PUBLIC_AI_ENABLED="false"
NEXT_PUBLIC_DEFAULT_LOCALE="ar"
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY="__RUNTIME_GOOGLE_MAPS_API_KEY__"

[ -f "$FRONTEND_DIR/Dockerfile" ] || { echo "ERROR: no Dockerfile at $FRONTEND_DIR" >&2; exit 1; }

echo "==> Platform: $PLATFORM (host: $(uname -m))"

echo "==> Building API image ($API_IMAGE) ..."
docker buildx build --platform "$PLATFORM" --target production -t "$API_IMAGE" --load .

echo "==> Verifying the API image's entrypoint layout ..."
docker run --rm --entrypoint node "$API_IMAGE" \
  -e "require('fs').accessSync('/app/dist/main.js'); require('fs').accessSync('/app/dist/database/data-source.js')" \
  || { echo "ERROR: $API_IMAGE has no dist/main.js — check tsconfig.build.json excludes." >&2; exit 1; }

echo "==> Building dashboard image ($WEB_IMAGE) ..."
docker buildx build --platform "$PLATFORM" -t "$WEB_IMAGE" --load \
  --build-arg "NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL" \
  --build-arg "NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL" \
  --build-arg "NEXT_PUBLIC_AI_ENABLED=$NEXT_PUBLIC_AI_ENABLED" \
  --build-arg "NEXT_PUBLIC_DEFAULT_LOCALE=$NEXT_PUBLIC_DEFAULT_LOCALE" \
  --build-arg "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY" \
  "$FRONTEND_DIR"

echo "==> Verifying the Maps-key placeholder landed in $WEB_IMAGE ..."
docker run --rm --entrypoint sh "$WEB_IMAGE" \
  -c 'grep -rq "__RUNTIME_GOOGLE_MAPS_API_KEY__" .next/static' \
  || { echo "ERROR: placeholder token missing from $WEB_IMAGE .next/static." >&2; exit 1; }

echo "==> Verifying both images are $PLATFORM ..."
for img in "$API_IMAGE" "$WEB_IMAGE"; do
  arch="$(docker image inspect "$img" --platform "$PLATFORM" --format '{{.Os}}/{{.Architecture}}')" \
    || { echo "ERROR: $img has no $PLATFORM variant" >&2; exit 1; }
  echo "    $img -> $arch"
  [ "$arch" = "$PLATFORM" ] || { echo "ERROR: $img is $arch, expected $PLATFORM" >&2; exit 1; }
done

echo "==> Saving the two tarballs to $OUT/ ..."
rm -rf "$OUT" && mkdir -p "$OUT"
docker save --platform "$PLATFORM" "$API_IMAGE" | gzip > "$OUT/cashvan-api-prod.tar.gz"
docker save --platform "$PLATFORM" "$WEB_IMAGE" | gzip > "$OUT/cashvan-dashboard-prod.tar.gz"

echo "==> Done."
ls -lh "$OUT"
