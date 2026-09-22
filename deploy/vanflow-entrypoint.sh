#!/bin/sh
# Start the backend and the office dashboard, and keep the container's fate tied
# to both.
#
# `wait -n` returns as soon as EITHER child exits, so a crashed backend brings
# the container down and the restart policy handles it. Without that the
# container would sit "up" with a dead API — the failure that is hardest to
# notice, because the dashboard still serves pages and only the data is missing.
#
# Sibling of suite-entrypoint.sh, which also starts the ERP. This one exists
# because a client who already runs their own ERP does not want a second one
# inside this container; see Dockerfile.vanflow.

set -eu

: "${DASHBOARD_PORT:=3001}"
: "${BACKEND_PORT:=3100}"

log() { echo "[vanflow] $*"; }

# The Google Maps key is baked into the dashboard bundle as a placeholder so one
# image can ship to clients with different keys. Substituted here, before the
# server starts serving those files.
substitute_maps_key() {
  placeholder="__RUNTIME_GOOGLE_MAPS_API_KEY__"
  replacement="${GOOGLE_MAPS_API_KEY:-}"
  [ -d /srv/dashboard/.next/static ] || return 0
  grep -rl "$placeholder" /srv/dashboard/.next/static 2>/dev/null | while IFS= read -r f; do
    sed -i "s|$placeholder|$replacement|g" "$f"
  done
  if [ -z "$replacement" ]; then
    # Not fatal: only the map view degrades, and a client without maps still
    # needs the rest of the dashboard.
    log "warning: GOOGLE_MAPS_API_KEY is unset — map views will not load"
  fi
}

# Only the BACKEND's database settings are required here — the ERP is not in
# this image, so DATABASE_URL and SESSION_SECRET are deliberately NOT demanded.
# Checking them anyway would refuse to start a perfectly valid deployment.
#
# The check itself matters for the reason recorded in suite-entrypoint.sh: the
# backend falls back to built-in localhost/cashvan defaults, which boots cleanly
# and then fails every request — a failure that looks like a healthy container.
missing=""
[ -n "${DB_HOST:-}" ]        || missing="$missing DB_HOST"
[ -n "${DB_NAME:-}" ]        || missing="$missing DB_NAME"
[ -n "${DB_USERNAME:-}" ]    || missing="$missing DB_USERNAME"
[ -n "${DB_PASSWORD:-}" ]    || missing="$missing DB_PASSWORD"
[ -n "${JWT_SECRET:-}" ]     || missing="$missing JWT_SECRET"

if [ -n "$missing" ]; then
  log "FATAL: missing required environment:$missing"
  log "       Refusing to start. The backend would otherwise fall back to its"
  log "       built-in localhost/cashvan defaults, boot successfully, and fail"
  log "       every request — a failure that looks like a healthy container."
  exit 1
fi

substitute_maps_key

log "starting backend   on :${BACKEND_PORT}"
( cd /srv/backend  && PORT="$BACKEND_PORT"  node dist/main.js ) &

log "starting dashboard on :${DASHBOARD_PORT}"
( cd /srv/dashboard && PORT="$DASHBOARD_PORT" HOSTNAME=0.0.0.0 node server.js ) &

log "both started; container exits if either does"

# Exit with the code of whichever child died first, so `docker ps` and the
# restart policy see a real failure rather than a clean exit.
wait -n
code=$?
log "a service exited (code ${code}) — stopping the container"
exit "$code"
