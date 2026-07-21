#!/usr/bin/env bash
#
# import-local.sh — restore ERP + VanFlow dumps (from export-onprem.ps1) into the
# local Docker Postgres containers on your Mac.
#
# Usage:
#   ./import-local.sh --erp ~/dumps/erp-20260715-101500.dump \
#                     --van ~/dumps/cashvan-20260715-101500.dump [--wipe]
#
# Options:
#   --erp <file>        ERP dump to restore   (omit to skip ERP)
#   --van <file>        VanFlow dump to restore (omit to skip VanFlow)
#   --erp-repo <dir>    ERP repo dir      (default ~/IdeaProjects/ERP)
#   --van-repo <dir>    VanFlow repo dir  (default ~/IdeaProjects/cash-van-dashboard)
#   --wipe              docker compose down -v first (drops existing local data)
#
# It starts ONLY the db service, waits for Postgres, restores with
# --clean --if-exists --no-owner, then starts the full stack.
set -uo pipefail

ERP_DUMP="" ; VAN_DUMP=""
ERP_REPO="$HOME/IdeaProjects/ERP"
VAN_REPO="$HOME/IdeaProjects/cash-van-dashboard"
ERP_CONTAINER="erp-postgres" ; ERP_USER="postgres" ; ERP_DB="erp_database"
VAN_CONTAINER="cashvan-db"   ; VAN_USER="cashvan"  ; VAN_DB="cashvan"
WIPE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --erp)      ERP_DUMP="$2"; shift 2;;
    --van)      VAN_DUMP="$2"; shift 2;;
    --erp-repo) ERP_REPO="$2"; shift 2;;
    --van-repo) VAN_REPO="$2"; shift 2;;
    --wipe)     WIPE=1; shift;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

docker version >/dev/null || { echo "Docker is not running." >&2; exit 1; }

restore() {
  local repo="$1" container="$2" user="$3" db="$4" dump="$5"
  if [[ ! -f "$dump" ]]; then echo "X  dump not found: $dump" >&2; return 1; fi
  if [[ ! -d "$repo" ]]; then echo "X  repo not found: $repo" >&2; return 1; fi
  echo "==> $db   (repo: $repo)"
  (
    cd "$repo" || exit 1
    if [[ "$WIPE" == "1" ]]; then echo "   wiping local volume (down -v)…"; docker compose down -v; fi
    echo "   starting db…"; docker compose up -d db
    echo -n "   waiting for postgres"
    for _ in $(seq 1 45); do
      if docker exec "$container" pg_isready -U "$user" -d "$db" >/dev/null 2>&1; then break; fi
      echo -n "."; sleep 1
    done
    echo
    docker cp "$dump" "$container:/tmp/restore.dump"
    echo "   restoring…"
    if docker exec "$container" pg_restore -U "$user" -d "$db" \
         --clean --if-exists --no-owner /tmp/restore.dump; then
      echo "   OK  $db restored cleanly"
    else
      echo "   !  pg_restore reported warnings — review the output above"
    fi
    docker exec "$container" rm -f /tmp/restore.dump
    echo "   starting full stack…"; docker compose up -d
  )
}

[[ -n "$ERP_DUMP" ]] && restore "$ERP_REPO" "$ERP_CONTAINER" "$ERP_USER" "$ERP_DB" "$ERP_DUMP"
[[ -n "$VAN_DUMP" ]] && restore "$VAN_REPO" "$VAN_CONTAINER" "$VAN_USER" "$VAN_DB" "$VAN_DUMP"

if [[ -z "$ERP_DUMP" && -z "$VAN_DUMP" ]]; then
  echo "Nothing to do — pass --erp <file> and/or --van <file>. See --help." >&2
  exit 1
fi
echo "Done.  ERP → http://localhost:3000   VanFlow API → http://localhost:3002 (or your mapped ports)."
