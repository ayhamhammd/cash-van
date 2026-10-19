# Human test, part 3 — the ERP

Parts 1 and 2 covered cash-van and the CRM, and you passed all sixteen. This covers what has been
built since: the ERP locked down the same way cash-van is, connected to the CRM, and cash-van and
the ERP introducing themselves to each other.

About 25 minutes. Everything below was run against this stack before being written down.

## What is running

| | URL | Sign in with |
|---|---|---|
| ERP | http://localhost:3500/login | see below |
| CRM dashboard | http://localhost:3400 | `admin@7software.local` / `platform1234` |
| Van dashboard | http://localhost:3300/login | licence key + `admin@admin.com` / `testpass1234` |

**ERP logins**, both with password `erppass12345`:

| Email | Company |
|---|---|
| `admin@alpha.local` | Alpha Trading Co |
| `boss@fullco.local` | Full Suite Co **and** Pair Co — two companies, so it shows the picker |

Each ERP company has one customer named after itself, all coded `SECRET-1`. Same code in every
company on purpose: if a filter goes missing you get more than one row.

A shortcut for the commands below:

```bash
alias vf='docker compose -f ~/Projects/cash-van/docker-compose.suite.yml --env-file ~/Projects/cash-van/.env.suite'
```

---

## TEST E1 — every ERP table is locked

The single most valuable check. It is the one to keep and re-run after any change that adds a
table.

```bash
vf exec erp-db psql -U postgres -d erp_database -c "
SELECT c.relname AS unprotected_table
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p')
   AND c.relname NOT IN ('organizations','users','organization_members','role_template_perms','__drizzle_migrations')
   AND (NOT c.relrowsecurity
        OR NOT c.relforcerowsecurity
        OR NOT EXISTS (SELECT 1 FROM pg_policy p
                        WHERE p.polrelid=c.oid AND p.polname='org_isolation'
                          AND p.polqual IS NOT NULL))
 ORDER BY 1;"
```

✅ **PASS:** `(0 rows)` — all 147 tables carry the lock.

The `polqual IS NOT NULL` part matters. A policy with no condition permits every row, and an
earlier version of this check would have called that protected. It is exactly the trap Drizzle
fell into when I tried to express these rules in `schema.ts`.

---

## TEST E2 — two companies cannot see each other, on the real screen

1. http://localhost:3500/login → `admin@alpha.local` / `erppass12345`
2. Top-left reads **Alpha Trading Co**
3. Left menu → **Sales → Customers**

✅ **One** customer: `Alpha Trading Co — Secret Client`

4. Sign out → log in as `boss@fullco.local` / `erppass12345`
5. It asks **which company** — pick **Full Suite Co**
6. **Sales → Customers**

✅ **One** customer: `Full Suite Co — Secret Client`

❌ **FAIL:** two rows, or the other company's customer.

---

## TEST E3 — the org picker still works ★ your multi-company feature

The locks could have broken this and it would only show up here. A user with two companies has to
be able to list them **before** picking one — and that list is read while no company is selected.

7. Still as `boss@fullco.local`, click the **company name at the top-left**
8. ✅ Both **Full Suite Co** and **Pair Co** are offered
9. Switch to **Pair Co**
10. **Sales → Customers** → ✅ only `Pair Co — Secret Client`
11. Switch back to **Full Suite Co** → ✅ only its own again

❌ **FAIL:** the picker is empty, only one company is listed, or switching shows the wrong data.

*(Pair Co is a leftover: its CRM record was deleted but the ERP organisation stayed. That is
deliberate — deleting a company in the CRM never reaches into a product and removes its records.)*

---

## TEST E4 — one company cannot write into another

```bash
vf exec erp-db psql -U postgres -d erp_database -c "
BEGIN;
SET ROLE erp_app;
SELECT set_config('app.org_id',(SELECT id::text FROM organizations WHERE name='Alpha Trading Co'),true);
INSERT INTO customers (org_id, name)
VALUES ((SELECT id FROM organizations WHERE name='Full Suite Co'), 'SMUGGLED');
ROLLBACK;"
```

✅ **PASS:** `ERROR: new row violates row-level security policy for table "customers"`

Postgres refuses it. Not the ERP's code — the database. A query written in a hurry cannot get past
this.

---

## TEST E5 — with no company set, nothing is visible

```bash
vf exec erp-db psql -U postgres -d erp_database -c "
BEGIN; SET ROLE erp_app; SELECT count(*) FROM customers; ROLLBACK;"
```

✅ **PASS:** `0`

Forgetting the company shows **nothing**, never everything. That is the whole point: the mistake
becomes an empty screen in testing instead of a customer reading a competitor's ledger.

---

## TEST E6 — the CRM can switch the ERP off

Same three levers you already tested on cash-van, now reaching the ERP.

```bash
# Read what the ERP currently believes about Alpha
SECRET=$(vf exec -T erp-app sh -c 'echo -n "$CRM_INTERNAL_SECRET"')
ORG=$(vf exec -T erp-db psql -U postgres -d erp_database -t -A -c \
  "SELECT id FROM organizations WHERE name='Alpha Trading Co';")

check() { curl -s "http://localhost:3500/api/v1/internal/entitlements?orgId=$ORG&fresh=1" \
  -H "x-internal-secret: $SECRET" | jq -c '.data'; }

check
```

✅ `{"valid":true,"features":[…8 of them…],"writesAllowed":true}`

Now, in the CRM dashboard: **Companies → ALPHA → Licences**, find the **erp** licence.

| Do this in the CRM | Then run `check` | Expect |
|---|---|---|
| **Suspend** | | `writesAllowed: false` — reads stay, saving stops |
| **Reactivate**, then untick **ai** | | `ai` gone from features |
| Tick **ai** back on, then **Revoke** | | `valid: false, reason: "revoked"` |

Set it back to **active** with all features when you are done.

*(`fresh=1` skips the one-minute cache. Without it, changes take up to 60 seconds — which is the
real behaviour customers see.)*

---

## TEST E7 — the CRM down must not stop the ERP

```bash
vf stop crm-api
curl -s "http://localhost:3500/api/v1/internal/entitlements?orgId=$ORG" -H "x-internal-secret: $SECRET" | jq -c '.data'
vf start crm-api
```

✅ **PASS:** still `valid: true` — the ERP keeps working on its cached answer for up to 24 hours.

A customer who has already paid must not stop working because our billing system fell over.

---

## TEST E8 — cash-van and the ERP connect themselves ★ the new one

Until now someone had to open the cash-van settings screen and type in the ERP's address and a key.
For a cloud customer that step is gone.

1. http://localhost:3400 → **Companies** → **New company**
2. Code `LINKCO`, Name `Link Co`, admin email `boss@linkco.local`, name `Link Boss`,
   password `linkpass12345`
3. **Create** → **Open the company**
4. Password `linkpass12345` → **Provision cash-van**
5. **Provision ERP** (same page, same password)

Now look at what cash-van was told, without anyone typing it:

```bash
vf exec cashvan-db psql -U cashvan -d cashvan -c "
SELECT t.code, s.erp_sync_enabled, s.erp_base_url, s.erp_api_key_last4
  FROM app_settings s JOIN tenants t ON t.id = s.tenant_id
 WHERE t.code = 'LINKCO';"
```

✅ **PASS:** sync enabled `t`, a base URL, and the last four characters of a key.

**Order does not matter** — provision the ERP first and cash-van second and it still pairs.
Whichever is second triggers it.

6. Sign in to the van dashboard with LINKCO's licence key, open **Settings → ERP**

✅ The connection is already filled in.

---

## TEST E9 — a hand-set connection is never overwritten ★ the on-premise guarantee

Your existing customers run both products on their own machine. The CRM must never repoint them.

7. Still in the van dashboard for LINKCO: **Settings → ERP**, change the address to
   `http://my-own-server.local` and save
8. Back in the CRM, on **LINKCO**, press **Provision ERP** again

```bash
vf exec cashvan-db psql -U cashvan -d cashvan -c "
SELECT t.code, s.erp_base_url FROM app_settings s JOIN tenants t ON t.id=s.tenant_id WHERE t.code='LINKCO';"
```

✅ **PASS:** still `http://my-own-server.local`. The CRM left it alone.

You can confirm why in the CRM's log:

```bash
vf logs crm-api --since 2m | grep -i pair
```

✅ `Did not pair LINKCO (already_configured).`

9. Clean up: CRM → **LINKCO** → **Danger zone** → **Delete company** → type `LINKCO`

---

## What these tests do NOT cover

Worth knowing before you decide anything rests on them.

- **Only the Customers screen is converted.** The locks are on all 147 tables, but the ERP has
  roughly 683 entry points and one of them currently binds the company. Every other screen still
  runs on the old connection, which bypasses the locks — exactly as before this work, no worse.
  They gain protection one at a time as they are converted.
- **Nothing in the ERP is refused for a licence yet.** It can ask the CRM and gets correct
  answers (E6), but no ERP screen turns anyone away. That arrives with the same conversion.
- **cash-van ↔ ERP data sync itself is untested here.** E8 proves the two are *introduced*. Whether
  products and invoices then flow correctly is the existing sync, which this work did not change.
