# Part 2 — click-by-click

Six of these you do by clicking. Three can only be done in the database, because they test what
Postgres does when the application is wrong — there is no screen for that. Those three are one
command each, paste and read the answer.

**Before you start:** hard refresh both dashboards (Cmd+Shift+R). Everything was rebuilt.

Two keys, used throughout:

```
ALPHA  vf_c5282dd547579df7aa5b70d0627db834056b6a2c
BETA   vf_839c870970267e6e985be43c808ff72bfc37ba16
```

Both companies have `admin@admin.com` / `testpass1234`.

---

## TEST 8 — the token carries the company  ★ most important

If this one fails, nothing else here means anything.

1. Open http://localhost:3300/login
2. Press **تغيير / Change** if a company name is showing
3. Paste **ALPHA's key** → it says **Alpha Trading Co**
4. Log in `admin@admin.com` / `testpass1234`
5. Click **الحسابات / Customers** in the left menu
6. **Write down what you see** → should be **one** customer: `Alpha Shop`
7. Sign out (top-right power icon)
8. Press **Change** → paste **BETA's key** → it says **Beta Distribution**
9. Log in with the **same** `admin@admin.com` / `testpass1234`
10. Click **Customers** again

✅ **PASS:** one customer, `Beta Grocery`. Alpha Shop is nowhere.
❌ **FAIL:** you see Alpha Shop, or both, or the same list twice.

Both customers have the same number, `C-001`. Same screen, same login, two different companies.

---

## TEST 12 — the default admin must not work

1. http://localhost:3300/login
2. Press **Change** → paste **ALPHA's key** → it says **Alpha Trading Co**
3. Username: `admin`  Password: `admin1234`
4. Press **دخول / Sign in**

✅ **PASS:** refused — "Login failed. Check your credentials."
❌ **FAIL:** you get in. Stop and tell me.

Now the two that must still work:

5. Same ALPHA key, log in `admin@admin.com` / `testpass1234` → ✅ **Alpha Admin**
6. Sign out → **Change** → **empty the key box completely** → log in `admin` / `admin1234` → ✅ **Default Admin**

Step 6 is the single-company install. It genuinely needs that login.

---

## TEST 14 — each company has its own settings

1. Log in with **ALPHA's key**
2. Left menu → **الإعدادات / Settings**
3. Look at the company name field

✅ **Alpha Trading Co**, company number **ALPHA**

4. Sign out → **Change** → **BETA's key** → log in
5. **Settings** again

✅ **Beta Distribution**, company number **BETA**

❌ If either says **My Company** or **C001**, that company is reading the default company's settings.

---

## TEST 13 — numbering starts at 1 in each company

1. Log in with **ALPHA's key**
2. **Customers** → **إضافة / Add customer**
3. Name it `Alpha Number Test`, save
4. **Write down the customer number** it was given

✅ Should be **CUST-000001** — Alpha's own first customer

5. Sign out → **BETA's key** → log in
6. **Customers** → add `Beta Number Test`, save

✅ Also **CUST-000001**. Two companies, both starting at 1, neither continuing the other's count.

**Clean up:** delete both test customers.

---

## TEST 15 — a revoked key is dead

⚠️ **Do NOT revoke ALPHA's or BETA's key.** Revoke is final — the CRM offers no way back, and you
would lose them for every other test. Use a throwaway.

1. http://localhost:3400 → **Companies** → **New company**
2. Code `KILLME`, Name `Kill Me`, email `k@k.local`, name `K`, password `killpass12345`
3. **Create** → **Open the company**
4. Password `killpass12345` → **Provision cash-van**
5. **Copy the key** from the green box
6. Open http://localhost:3300/login → paste that key → ✅ says **Kill Me**
7. Back to the CRM, on that same company → **Licences** → **Revoke**
8. **Wait 60 seconds**
9. Reload the van login page and paste the key again

✅ **PASS:** *"This key isn't recognised, or it has been revoked."*

10. Clean up: **Danger zone** → **Delete company** → type `KILLME`

---

## TEST 16 — the CRM going down must not stop the vans

1. Log in to the van dashboard with **ALPHA's key** so it is cached
2. Now stop the CRM:

```bash
cd ~/Projects/cash-van
docker compose -f docker-compose.suite.yml --env-file .env.suite stop crm-api
```

3. Sign out of the van dashboard, then sign back in with ALPHA's key

✅ **PASS:** you still get in and can work normally. A customer who has paid keeps selling even
when our billing system is down.

4. Now try a key the system has never seen — press **Change** and paste
   `vf_neverseen00000000000000000000000000000`

✅ **PASS:** *"This key isn't recognised."* With no cached answer and no CRM, there is nothing to
go on, so it is refused.

5. Bring it back:

```bash
docker compose -f docker-compose.suite.yml --env-file .env.suite start crm-api
```

---

# The three that have no screen

These test what the **database** does when the application code is wrong. There is no button for
that. Paste each one and read the answer.

## TEST 9 — one company cannot write into another

```bash
cd ~/Projects/cash-van
docker compose -f docker-compose.suite.yml --env-file .env.suite exec \
  -e PGPASSWORD=cashvan_app_local_pw cashvan-db \
  psql -U cashvan_app -h 127.0.0.1 -d cashvan -c "
BEGIN;
SELECT set_config('app.tenant_id',(SELECT id::text FROM tenants WHERE code='ALPHA'),true);
INSERT INTO customers (tenant_id, customer_number, customer_name)
VALUES ((SELECT id FROM tenants WHERE code='BETA'), 'SMUGGLED', 'Should Not Exist');
ROLLBACK;"
```

✅ **PASS:** `ERROR: new row violates row-level security policy for table "customers"`

That is Postgres refusing, not our code. A bug in our code cannot get past it.

## TEST 10 — with no company set, nothing is visible

```bash
docker compose -f docker-compose.suite.yml --env-file .env.suite exec \
  -e PGPASSWORD=cashvan_app_local_pw cashvan-db \
  psql -U cashvan_app -h 127.0.0.1 -d cashvan -c "SELECT count(*) FROM customers;"
```

✅ **PASS:** `0`

Forgetting to set the company shows **nothing**, never everything. That is the difference between
a bug you find in testing and a bug your customer finds.

## TEST 11 — every table is protected  ★ keep this one for ever

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

✅ **PASS:** `(0 rows)`

Run this after **every** change that adds a table. It is the only thing that will still be
catching this mistake in two years.

---

## Order to run them

1. **Test 8** — if it fails, stop
2. **Test 12** — the security hole
3. **Test 11** — one command, keep it for ever
4. Then 14, 13, 9, 10, 15, 16 in any order
