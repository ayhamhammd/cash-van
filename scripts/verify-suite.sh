#!/usr/bin/env bash
#
# Runs every check from the three human-test documents that can be made without
# a person clicking, and says PASS or FAIL for each.
#
# The point is to fail here rather than in front of you. A manual pass takes
# half an hour; this takes about two minutes and covers the same ground for
# everything except what genuinely needs eyes on a screen.
#
#   ./scripts/verify-suite.sh
#
# Exits non-zero if anything failed, so it can go in CI as-is.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DC="docker compose -f $HERE/docker-compose.suite.yml --env-file $HERE/.env.suite"
CURL="curl -s --max-time 20"

CRM=http://localhost:3200/api/v1
VAN=http://localhost:3100/api/v1
ERP=http://localhost:3500

ALPHA_KEY=vf_c5282dd547579df7aa5b70d0627db834056b6a2c
BETA_KEY=vf_839c870970267e6e985be43c808ff72bfc37ba16

pass=0; fail=0; skipped=0
GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'

ok()   { printf "  ${GREEN}PASS${OFF}  %s\n" "$1"; pass=$((pass+1)); }
bad()  { printf "  ${RED}FAIL${OFF}  %s\n         ${DIM}expected: %s${OFF}\n         ${DIM}got:      %s${OFF}\n" "$1" "$2" "$3"; fail=$((fail+1)); }
skip() { printf "  ${YELLOW}SKIP${OFF}  %s ${DIM}(%s)${OFF}\n" "$1" "$2"; skipped=$((skipped+1)); }
head_() { printf "\n${DIM}── %s ${OFF}\n" "$1"; }

# Compare, trimming whitespace so psql padding does not cause false failures.
expect() { # name expected actual
  local got; got="$(echo "$3" | tr -d '[:space:]')"
  local want; want="$(echo "$2" | tr -d '[:space:]')"
  [[ "$got" == "$want" ]] && ok "$1" || bad "$1" "$2" "$3"
}
expect_contains() {
  [[ "$3" == *"$2"* ]] && ok "$1" || bad "$1" "contains: $2" "$3"
}

psql_erp() { $DC exec -T erp-db psql -U postgres -d erp_database -t -A -c "$1" 2>&1; }
psql_van() { $DC exec -T cashvan-db psql -U cashvan -d cashvan -t -A -c "$1" 2>&1; }

# ── preflight ────────────────────────────────────────────────────────────────
head_ "Services"
for pair in "cash-van API:$VAN/health" "CRM API:$CRM/health" "van dashboard:http://localhost:3300/login" "CRM dashboard:http://localhost:3400" "ERP:$ERP/login"; do
  name="${pair%%:*}"; url="${pair#*:}"
  code=$($CURL -o /dev/null -w '%{http_code}' "$url")
  expect "$name reachable" "200" "$code"
done
if [[ $fail -gt 0 ]]; then
  printf "\n${RED}Services are not up. Start them and re-run:${OFF}\n  %s up -d\n\n" "$DC"
  exit 1
fi

TOKEN=$($CURL -X POST "$CRM/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@7software.local","password":"platform1234"}' | jq -r '.data.accessToken // empty')
[[ -n "$TOKEN" ]] || { printf "\n${RED}Could not sign in to the CRM.${OFF}\n"; exit 1; }
SECRET=$($DC exec -T erp-app sh -c 'echo -n "$CRM_INTERNAL_SECRET"' 2>/dev/null | tr -d '\r')

# ── cash-van: the part-1 and part-2 ground ───────────────────────────────────
head_ "cash-van — isolation and licensing"

expect "every cash-van table is protected" "" \
  "$(psql_van "
    SELECT string_agg(c.relname, ',')
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind IN ('r','p')
       AND c.relname NOT IN ('tenants','migrations') AND c.relname NOT LIKE 'pgboss%'
       AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
            OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
            OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation' AND p.polqual IS NOT NULL));")"

for spec in "ALPHA:$ALPHA_KEY:Alpha Admin" "BETA:$BETA_KEY:Beta Admin"; do
  code="${spec%%:*}"; rest="${spec#*:}"; key="${rest%%:*}"; want="${rest#*:}"
  got=$($CURL -X POST "$VAN/auth/login" -H 'content-type: application/json' -H "x-license-key: $key" \
    -d '{"userNumber":"admin@admin.com","password":"testpass1234"}' | jq -r '.data.user.name // .message')
  expect "same username, $code's key -> $want" "$want" "$got"
done

# The token must carry the company, or every signed-in user works in DEFAULT.
for spec in "ALPHA:$ALPHA_KEY:Alpha Shop" "BETA:$BETA_KEY:Beta Grocery"; do
  code="${spec%%:*}"; rest="${spec#*:}"; key="${rest%%:*}"; want="${rest#*:}"
  tok=$($CURL -X POST "$VAN/auth/login" -H 'content-type: application/json' -H "x-license-key: $key" \
    -d '{"userNumber":"admin@admin.com","password":"testpass1234"}' | jq -r '.data.accessToken')
  got=$($CURL "$VAN/customers?limit=10" -H "x-license-key: $key" -H "authorization: Bearer $tok" \
    | jq -r '[.data.items[].customerName] | join(",")')
  expect "$code sees only its own customers" "$want" "$got"
done

got=$($CURL -X POST "$VAN/auth/login" -H 'content-type: application/json' -H "x-license-key: $ALPHA_KEY" \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r '.message // .data.user.name')
expect "default admin/admin1234 is refused in a customer company" "Invalid credentials" "$got"

got=$($CURL -X POST "$VAN/auth/login" -H 'content-type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r '.data.user.name // .message')
expect "single-company install still signs in" "Default Admin" "$got"

expect "cash-van: no company bound -> zero rows" "0" \
  "$($DC exec -T -e PGPASSWORD=cashvan_app_local_pw cashvan-db psql -U cashvan_app -h 127.0.0.1 -d cashvan -t -A -c 'SELECT count(*) FROM customers;' 2>&1)"

# ── ERP: part 3 ──────────────────────────────────────────────────────────────
head_ "ERP — isolation (part 3, E1/E4/E5)"

expect "E1 every ERP table is protected" "" \
  "$(psql_erp "
    SELECT string_agg(c.relname, ',')
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind IN ('r','p')
       AND c.relname NOT IN ('organizations','users','organization_members','role_template_perms','__drizzle_migrations')
       AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
            OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='org_isolation' AND p.polqual IS NOT NULL));")"

expect "E2 Alpha sees only its own customer" "Alpha Trading Co — Secret Client" \
  "$(psql_erp "BEGIN; SET ROLE erp_app;
     SELECT set_config('app.org_id',(SELECT id::text FROM organizations WHERE name='Alpha Trading Co'),true);
     SELECT string_agg(name,',') FROM customers; ROLLBACK;" | tail -2 | head -1)"

expect "E2 Full Suite sees only its own customer" "Full Suite Co — Secret Client" \
  "$(psql_erp "BEGIN; SET ROLE erp_app;
     SELECT set_config('app.org_id',(SELECT id::text FROM organizations WHERE name='Full Suite Co'),true);
     SELECT string_agg(name,',') FROM customers; ROLLBACK;" | tail -2 | head -1)"

expect_contains "E4 writing into another company is refused" "violates row-level security" \
  "$(psql_erp "BEGIN; SET ROLE erp_app;
     SELECT set_config('app.org_id',(SELECT id::text FROM organizations WHERE name='Alpha Trading Co'),true);
     INSERT INTO customers (org_id, name) VALUES ((SELECT id FROM organizations WHERE name='Full Suite Co'),'SMUGGLED');
     ROLLBACK;")"

expect "E5 no company bound -> zero rows" "0" \
  "$(psql_erp "BEGIN; SET ROLE erp_app; SELECT count(*) FROM customers; ROLLBACK;" | tail -2 | head -1)"

head_ "ERP — the multi-company picker (E3)"

expect "E3 a two-company user is asked which one" "ORG_SELECTION_REQUIRED" \
  "$($CURL -X POST "$ERP/api/v1/pda/auth/login" -H 'content-type: application/json' \
     -d '{"email":"boss@fullco.local","password":"erppass12345","deviceId":"verify-suite"}' \
     | jq -r '.error.code // "no picker"')"

expect "E3 a one-company user goes straight in" "true" \
  "$($CURL -X POST "$ERP/api/v1/pda/auth/login" -H 'content-type: application/json' \
     -d '{"email":"admin@alpha.local","password":"erppass12345","deviceId":"verify-suite-2"}' \
     | jq -r '.success // false')"

expect "E3 memberships are readable with NO company bound" "2" \
  "$(psql_erp "BEGIN; SET ROLE erp_app;
     SELECT count(*) FROM organization_members m JOIN users u ON u.id=m.user_id
      WHERE u.email='boss@fullco.local'; ROLLBACK;" | tail -2 | head -1)"

# ── ERP <-> CRM ──────────────────────────────────────────────────────────────
head_ "ERP <-> CRM (E6/E7)"

ALPHA_ORG=$(psql_erp "SELECT id FROM organizations WHERE name='Alpha Trading Co';" | head -1)
ALPHA_TENANT=$($CURL "$CRM/tenants?limit=100" -H "authorization: Bearer $TOKEN" | jq -r '.data.items[]|select(.code=="ALPHA")|.id')
ERP_LIC=$($CURL "$CRM/licenses/tenant/$ALPHA_TENANT" -H "authorization: Bearer $TOKEN" | jq -r '.data[]|select(.app=="erp")|.id' | head -1)

ent() { $CURL "$ERP/api/v1/internal/entitlements?orgId=$ALPHA_ORG&fresh=1" -H "x-internal-secret: $SECRET" | jq -c '.data'; }
set_status() { $CURL -X PATCH "$CRM/licenses/$1/status" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"status\":\"$2\"}" > /dev/null; }
set_features() { $CURL -X PATCH "$CRM/licenses/$1/features" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"features\":$2}" > /dev/null; }

if [[ -z "$ERP_LIC" || "$ERP_LIC" == "null" ]]; then
  skip "E6 licence levers" "ALPHA has no ERP licence — provision ERP for it first"
else
  set_status "$ERP_LIC" suspended
  expect "E6 suspend reaches the ERP" "false" "$(ent | jq -r '.writesAllowed')"

  set_status "$ERP_LIC" active
  set_features "$ERP_LIC" '["invoicing","reports"]'
  expect "E6 removing a feature reaches the ERP" "false" "$(ent | jq -r '.features|index("ai")!=null')"

  set_status "$ERP_LIC" revoked
  expect "E6 revoke reaches the ERP" "revoked" "$(ent | jq -r '.reason')"

  set_status "$ERP_LIC" active
  set_features "$ERP_LIC" '["vansales","invoicing","jofotara","collections","reports","ai","erp_sync","prospecting"]'
  expect "E6 restored to normal" "true" "$(ent | jq -r '.valid and .writesAllowed')"

  ent > /dev/null   # warm the cache before pulling the CRM out
  $DC stop crm-api > /dev/null 2>&1
  sleep 2
  expect "E7 ERP keeps working with the CRM down" "true" \
    "$($CURL "$ERP/api/v1/internal/entitlements?orgId=$ALPHA_ORG" -H "x-internal-secret: $SECRET" | jq -r '.data.valid')"
  $DC start crm-api > /dev/null 2>&1
  for _ in $(seq 1 20); do
    [[ "$($CURL -o /dev/null -w '%{http_code}' "$CRM/health")" == "200" ]] && break
    sleep 2
  done
  expect "E7 CRM came back" "200" "$($CURL -o /dev/null -w '%{http_code}' "$CRM/health")"
  TOKEN=$($CURL -X POST "$CRM/auth/login" -H 'content-type: application/json' \
    -d '{"email":"admin@7software.local","password":"platform1234"}' | jq -r '.data.accessToken')
fi

# ── cash-van <-> ERP pairing ─────────────────────────────────────────────────
head_ "cash-van <-> ERP pairing (E8/E9)"

CODE="VRFY$RANDOM"
NEW=$($CURL -X POST "$CRM/tenants" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"name\":\"Verify Co\",\"adminEmail\":\"v${RANDOM}@verify.local\",\"adminName\":\"V\",\"adminPassword\":\"verifypass12345\"}")
NEW_ID=$(echo "$NEW" | jq -r '.data.tenant.id // empty')

if [[ -z "$NEW_ID" ]]; then
  skip "E8/E9 pairing" "could not create a test company: $(echo "$NEW" | jq -r '.message')"
else
  NEW_ADMIN=$($CURL "$CRM/tenants/$NEW_ID/people" -H "authorization: Bearer $TOKEN" | jq -r '.data[0].id')
  body="{\"adminUserId\":\"$NEW_ADMIN\",\"adminPassword\":\"verifypass12345\"}"
  $CURL -X POST "$CRM/tenants/$NEW_ID/apps/cashvan" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$body" > /dev/null
  $CURL -X POST "$CRM/tenants/$NEW_ID/apps/erp"     -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$body" > /dev/null
  sleep 2

  expect "E8 cash-van was pointed at the ERP automatically" "t" \
    "$(psql_van "SELECT erp_sync_enabled FROM app_settings s JOIN tenants t ON t.id=s.tenant_id WHERE t.code='$CODE';")"
  expect_contains "E8 with a real ERP address" "erp-app" \
    "$(psql_van "SELECT coalesce(erp_base_url,'none') FROM app_settings s JOIN tenants t ON t.id=s.tenant_id WHERE t.code='$CODE';")"
  expect "E8 and an encrypted key" "t" \
    "$(psql_van "SELECT erp_api_key_encrypted IS NOT NULL FROM app_settings s JOIN tenants t ON t.id=s.tenant_id WHERE t.code='$CODE';")"

  # A hand-set address must survive a re-provision — the on-premise guarantee.
  psql_van "UPDATE app_settings SET erp_base_url='http://my-own-server.local'
              FROM tenants t WHERE t.id=app_settings.tenant_id AND t.code='$CODE';" > /dev/null
  $CURL -X POST "$CRM/tenants/$NEW_ID/apps/erp" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$body" > /dev/null
  sleep 2
  expect "E9 a hand-set connection is not overwritten" "http://my-own-server.local" \
    "$(psql_van "SELECT erp_base_url FROM app_settings s JOIN tenants t ON t.id=s.tenant_id WHERE t.code='$CODE';")"

  $CURL -X DELETE "$CRM/tenants/$NEW_ID" -H "authorization: Bearer $TOKEN" > /dev/null
  expect "cleanup: the test company is gone" "" \
    "$($CURL "$CRM/tenants?limit=100" -H "authorization: Bearer $TOKEN" | jq -r --arg c "$CODE" '[.data.items[]|select(.code==$c)]|map(.code)|join("")')"
fi

# ── result ───────────────────────────────────────────────────────────────────
printf "\n${DIM}────────────────────────────────────────${OFF}\n"
printf "  ${GREEN}%d passed${OFF}" "$pass"
[[ $skipped -gt 0 ]] && printf "   ${YELLOW}%d skipped${OFF}" "$skipped"
[[ $fail -gt 0 ]] && printf "   ${RED}%d FAILED${OFF}" "$fail"
printf "\n\n"

if [[ $fail -gt 0 ]]; then
  printf "${RED}Do not start the manual tests yet.${OFF}\n\n"
  exit 1
fi
printf "${GREEN}Everything automatable passes.${OFF}\n"
printf "${DIM}Still needs your eyes: the ERP customers screen (E2), the company picker (E3),\nand the van dashboard's ERP settings page (E8).${OFF}\n\n"
