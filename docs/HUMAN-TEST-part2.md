# Human test, part 2 — the ones that catch leaks

Part 1 proved the system does what it should. These are the tests that try to make it do what it
should not. Every one of them was run against this stack before being written down, and **three
of them found real bugs**, all now fixed:

| Found | What it was |
|---|---|
| Every company had a hidden `admin` / `admin1234` login | Anyone holding a licence key owned that company |
| Tokens carried no company | A signed-in Alpha admin read **and wrote** the wrong company's data |
| Provisioned companies had no settings row | They silently read the default company's settings |

Roughly 25 minutes.

---

## Test 8 — the token must carry the company

**The point:** the licence key picks the company *for the login*. The token has to carry it for
every request afterwards. When it did not, every signed-in user of every company was silently
working inside `DEFAULT` — reads and writes both, with nothing reporting a problem.

```bash
A=vf_c5282dd547579df7aa5b70d0627db834056b6a2c   # ALPHA
B=vf_839c870970267e6e985be43c808ff72bfc37ba16   # BETA

for K in $A $B; do
  TOK=$(curl -s -X POST http://localhost:3100/api/v1/auth/login \
    -H 'content-type: application/json' -H "x-license-key: $K" \
    -d '{"userNumber":"admin@admin.com","password":"testpass1234"}' | jq -r '.data.accessToken')
  echo -n "${K:0:12}… sees: "
  curl -s "http://localhost:3100/api/v1/customers?limit=10" \
    -H "x-license-key: $K" -H "authorization: Bearer $TOK" \
    | jq -c '[.data.items[] | .customerNumber + " " + .customerName]'
done
```

**Expect:**

```
vf_c5282dd54… sees: ["C-001 Alpha Shop"]
vf_839c87097… sees: ["C-001 Beta Grocery"]
```

Same customer number, same endpoint, same credentials — two different answers. If both lines are
identical, the token has lost the company and **nothing else in this document can be trusted.**

**Do it in the dashboard too:** sign in with ALPHA's key, open Customers, note what is there. Sign
out, switch to BETA's key, sign in, open Customers. The lists must have nothing in common.

---

## Test 9 — a company cannot write into another company

**The point:** reading is only half of it. A bug that stamps the wrong company on an INSERT is
worse than one that shows too much, because it corrupts data rather than exposing it.

```bash
docker compose -f docker-compose.suite.yml --env-file .env.suite exec \
  -e PGPASSWORD=cashvan_app_local_pw cashvan-db \
  psql -U cashvan_app -h 127.0.0.1 -d cashvan -c "
BEGIN;
SELECT set_config('app.tenant_id',(SELECT id::text FROM tenants WHERE code='ALPHA'),true);
INSERT INTO customers (tenant_id, customer_number, customer_name)
VALUES ((SELECT id FROM tenants WHERE code='BETA'), 'SMUGGLED', 'Should Not Exist');
ROLLBACK;"
```

**Expect:** `ERROR: new row violates row-level security policy for table "customers"`.

Postgres refuses it. Not the application — the database. A bug in our code cannot get around this.

---

## Test 10 — with no company set, nothing is visible

**The point:** the failure mode has to be *empty*, never *everything*. A code path that forgets to
set the company must break loudly in testing rather than quietly serve the whole database.

```bash
docker compose -f docker-compose.suite.yml --env-file .env.suite exec \
  -e PGPASSWORD=cashvan_app_local_pw cashvan-db \
  psql -U cashvan_app -h 127.0.0.1 -d cashvan -c "SELECT count(*) FROM customers;"
```

**Expect:** `0`. Not an error, not every customer — zero.

---

## Test 11 — every table is protected, including the ones added tomorrow

**The point:** this is the test worth keeping for ever. It fails the day someone adds a table and
forgets tenancy, which is the only way this stays correct once everyone has moved on.

```bash
docker compose -f docker-compose.suite.yml --env-file .env.suite exec cashvan-db \
  psql -U cashvan -d cashvan -c "
SELECT c.relname AS unprotected_table
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
   AND c.relname NOT IN ('tenants','migrations')
   AND c.relname NOT LIKE 'pgboss%'
   AND (NOT c.relrowsecurity
        OR NOT c.relforcerowsecurity
        OR NOT EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
        OR NOT EXISTS (SELECT 1 FROM pg_policy p
                        WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'))
 ORDER BY 1;"
```

**Expect:** `(0 rows)`. Every single table has a company column, row-level security **forced**, and
an isolation policy.

---

## Test 12 — the default admin must not work in a customer's company

**The point:** this one was a real hole. Every provisioned company had an `admin` account with the
password `admin1234` — which is in the README. The licence key is on every phone and every office
browser the customer owns. Anyone who read one off a screen was an administrator of that company.

It also made nonsense of the reason keys are safe to share: *"a leaked key buys a login screen and
nothing else."* It did not.

```bash
for K in vf_c5282dd547579df7aa5b70d0627db834056b6a2c vf_839c870970267e6e985be43c808ff72bfc37ba16; do
  echo -n "${K:0:12}… + admin/admin1234 -> "
  curl -s -X POST http://localhost:3100/api/v1/auth/login -H 'content-type: application/json' \
    -H "x-license-key: $K" -d '{"userNumber":"admin","password":"admin1234"}' \
    | jq -r '.message // .data.user.name'
done
```

**Expect:** `Invalid credentials` for both.

Now check the two things that must still work:

```bash
# the real admin the CRM created
curl -s -X POST http://localhost:3100/api/v1/auth/login -H 'content-type: application/json' \
  -H 'x-license-key: vf_c5282dd547579df7aa5b70d0627db834056b6a2c' \
  -d '{"userNumber":"admin@admin.com","password":"testpass1234"}' | jq -r '.data.user.name'

# the single-company install, which genuinely needs its default login
curl -s -X POST http://localhost:3100/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"userNumber":"admin","password":"admin1234"}' | jq -r '.data.user.name'
```

**Expect:** `Alpha Admin`, then `Default Admin`.

---

## Test 13 — numbering starts at 1 for each company

**The point:** customer and invoice numbers used to come from one global counter. Company B would
have carried on from company A's last invoice — which their accountant would notice, and their
auditor would ask about.

Create a customer as ALPHA in the dashboard, then check:

```bash
docker compose -f docker-compose.suite.yml --env-file .env.suite exec cashvan-db \
  psql -U cashvan -d cashvan -c \
  "SELECT t.code, c.name, c.value FROM tenant_counters c
     JOIN tenants t ON t.id = c.tenant_id ORDER BY t.code, c.name;"
```

**Expect:** each company has its own counters, counting independently. A new company's first
customer is `CUST-000001` no matter how many exist elsewhere.

---

## Test 14 — each company has its own settings

**The point:** company name, tax mode, e-invoicing credentials and ERP connection are per company.
Before this was fixed a provisioned company had no settings row at all and silently read the
default company's — so every customer appeared to be called "My Company", numbered `C001`, and
pointed at somebody else's ERP.

```bash
for K in vf_c5282dd547579df7aa5b70d0627db834056b6a2c vf_839c870970267e6e985be43c808ff72bfc37ba16; do
  TOK=$(curl -s -X POST http://localhost:3100/api/v1/auth/login -H 'content-type: application/json' \
    -H "x-license-key: $K" -d '{"userNumber":"admin@admin.com","password":"testpass1234"}' | jq -r '.data.accessToken')
  curl -s http://localhost:3100/api/v1/settings -H "x-license-key: $K" -H "authorization: Bearer $TOK" \
    | jq -c '{company: .data.companyNameEn, number: .data.companyNumber}'
done
```

**Expect:** `Alpha Trading Co / ALPHA`, then `Beta Distribution / BETA`.

---

## Test 15 — a revoked key is dead immediately

**The point:** `suspended` is for a customer who has not paid — reversible, and they keep reading
their own records. `revoked` is for a key that leaked. It must be final.

In the CRM: **Companies → TOBACCO → Licences → Revoke.**

```bash
curl -s -X POST http://localhost:3200/api/v1/licenses/validate \
  -H 'content-type: application/json' -d '{"key":"<the revoked key>"}' | jq -c '.data'
```

**Expect:** `{"valid":false,"reason":"revoked"}` from the CRM, and from the product a flat refusal
— not even a login.

**This test found a bug.** cash-van computed `valid` and then never read it: it looked only at
`features` and `writesAllowed`, so a revoked key behaved exactly like a suspended one. Whoever
stole a key kept full read access to the company for ever, and the single lever meant to stop them
did nothing. The guard now refuses any key the CRM calls invalid.

Suspended and expired are deliberately NOT affected — those are billing states, the customer is
still the customer, and their records stay readable and exportable while writes are paused.

Entitlements are cached for a minute, so a revocation reaches the products within 60 seconds
rather than instantly. If a key has genuinely leaked, restart the API to clear the cache at once.

---

## Test 16 — the CRM going down must not stop the vans

**The point:** the control plane is billing infrastructure. If it falls over, customers who have
already paid must keep selling. Refusing to serve them to protect a billing check is the wrong
trade — and it would take every customer offline at once.

```bash
# Warm the cache, then pull the CRM out
curl -s http://localhost:3100/api/v1/auth/license \
  -H 'x-license-key: vf_c5282dd547579df7aa5b70d0627db834056b6a2c' | jq -r '.data.tenantName'

docker compose -f docker-compose.suite.yml --env-file .env.suite stop crm-api

curl -s -X POST http://localhost:3100/api/v1/auth/login -H 'content-type: application/json' \
  -H 'x-license-key: vf_c5282dd547579df7aa5b70d0627db834056b6a2c' \
  -d '{"userNumber":"admin@admin.com","password":"testpass1234"}' | jq -r '.data.user.name'
```

**Expect:** `Alpha Admin`. Work continues on the cached entitlement, for up to 24 hours.

A key the cache has never seen is a different matter — there is nothing to go on, so it is refused:

```bash
curl -s http://localhost:3100/api/v1/auth/license \
  -H 'x-license-key: vf_neverseen00000000000000000000000000000' | jq -c '.data'
```

**Expect:** `{"licensingEnabled":true,"recognised":false}`.

```bash
docker compose -f docker-compose.suite.yml --env-file .env.suite start crm-api
```

---

## Still untested, and worth knowing

- **Realtime.** Socket rooms are namespaced per company in code, but two browsers on two companies
  have not been watched side by side.
- **The mobile app.** It does not send a key at all yet, so a rep's phone is still bound to one
  install.
- **Concurrency.** The company is bound per request with `set_config(..., is_local => true)`, which
  is correct, but no load test has proven two simultaneous requests never cross.
- **The ERP.** Provisioned and linked, not licence-gated.
