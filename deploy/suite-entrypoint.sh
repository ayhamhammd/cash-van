#!/bin/sh
# Start ERP, backend and dashboard, and keep the container's fate tied to all
# three.
#
# `wait -n` returns as soon as ANY child exits, so a crashed backend brings the
# container down and the restart policy handles it. Without that the container
# would sit "up" with a dead API — the failure that is hardest to notice,
# because the two web apps still serve pages and only the data is missing.

set -eu

: "${ERP_PORT:=3000}"
: "${DASHBOARD_PORT:=3001}"
: "${BACKEND_PORT:=3100}"

log() { echo "[suite] $*"; }

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

# The two apps read DIFFERENT database settings — the ERP takes a single
# DATABASE_URL, the backend takes discrete DB_* parts. Checking only one was a
# real bug in an earlier version of this script: it demanded DATABASE_URL, which
# the backend never reads, and let the backend start with its built-in defaults
# (localhost/cashvan). That boots cleanly and then fails every request, which is
# precisely the failure this check exists to prevent.
missing=""
[ -n "${DATABASE_URL:-}" ] || missing="$missing DATABASE_URL(erp)"
[ -n "${DB_HOST:-}" ]      || missing="$missing DB_HOST(backend)"
[ -n "${DB_NAME:-}" ]      || missing="$missing DB_NAME(backend)"
[ -n "${DB_USERNAME:-}" ]  || missing="$missing DB_USERNAME(backend)"
[ -n "${DB_PASSWORD:-}" ]  || missing="$missing DB_PASSWORD(backend)"
[ -n "${JWT_SECRET:-}" ]   || missing="$missing JWT_SECRET(backend)"
[ -n "${SESSION_SECRET:-}" ] || missing="$missing SESSION_SECRET(erp)"

if [ -n "$missing" ]; then
  log "FATAL: missing required environment:$missing"
  log "       Refusing to start. The backend would otherwise fall back to its"
  log "       built-in localhost/cashvan defaults, boot successfully, and fail"
  log "       every request — a failure that looks like a healthy container."
  exit 1
fi

substitute_maps_key

log "starting backend  on :${BACKEND_PORT}"
( cd /srv/backend  && PORT="$BACKEND_PORT"  node dist/main.js ) &

log "starting ERP      on :${ERP_PORT}"
( cd /srv/erp       && PORT="$ERP_PORT"       HOSTNAME=0.0.0.0 node server.js ) &

log "starting dashboard on :${DASHBOARD_PORT}"
( cd /srv/dashboard && PORT="$DASHBOARD_PORT" HOSTNAME=0.0.0.0 node server.js ) &

log "all three started; container exits if any of them does"

# Exit with the code of whichever child died first, so `docker ps` and the
# restart policy see a real failure rather than a clean exit.
wait -n
code=$?
log "a service exited (code ${code}) — stopping the container"
exit "$code"
