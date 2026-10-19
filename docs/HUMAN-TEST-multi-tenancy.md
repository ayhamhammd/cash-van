# Human test — multi-tenancy, licensing and the CRM

Everything below runs on your machine right now. Roughly 20 minutes end to end.

If the stack is not up:

```bash
cd ~/Projects/cash-van
docker compose -f docker-compose.suite.yml --env-file .env.suite up -d
```

## What is running

| | URL | Sign in with |
|---|---|---|
| CRM API (start here) | http://localhost:3200/docs | `admin@7software.local` / `platform1234` |
| Van API | http://localhost:3100/docs | see below |
| Van dashboard | http://localhost:3300/login | `admin` / `admin1234` |
| ERP | http://localhost:3500/login | register on the page |
| CRM dashboard | http://localhost:3400 | `admin@7software.local` / `platform1234` |

The CRM dashboard has three screens: **Overview** (four numbers and anything needing a decision),
**Companies** (create, provision, inspect) and **Licences** (every key, filterable by status). It
opens in Arabic; **EN / ع** in the top bar switches, and the whole layout flips with it.

Companies that already exist: `DEFAULT`, `ALPHA`, `BETA`, `TOBACCO`, `FULLCO`.

Two licence keys are ready for you:

```
ALPHA  vf_c5282dd547579df7aa5b70d0627db834056b6a2c   (everything)
BETA   vf_839c870970267e6e985be43c808ff72bfc37ba16   (no ai, no prospecting)
```

Both companies have **two** admins, both with password `testpass1234`:

| Sign in with | Why it exists |
|---|---|
| `admin@admin.com` | The **same** address in both companies — this is what Test 1 proves |
| `admin@alpha.local` / `admin@beta.local` | What the CRM's **People** list shows for each |

Either works. The first is the interesting one: same address, same password, two different people.

---

## Test 1 — the same username in two companies

**The point:** before this work, usernames were unique across the whole database, so two
customers could never both have an `admin`. Now the licence key decides which company a login
means.

### 1a — in the dashboard, which is how a customer will actually do it

1. Open http://localhost:3300/login
2. Paste **ALPHA's key** into **مفتاح الترخيص / Licence key**

**Expect:** the field collapses into one line — *Signing in to **Alpha Trading Co***. That is the
dashboard asking the API who the key belongs to, before you have typed a password. A key with a
character missing says so here instead of letting you blame your password.

3. Sign in as `admin@admin.com` / `testpass1234`

**Expect:** the top bar reads **Alpha Admin · Admin · Alpha Trading Co**.

4. Sign out. Press **تغيير / Change** next to the company name, paste **BETA's key**, and sign in
   with the **same** username and password.

**Expect:** **Beta Admin · Beta Distribution**. Same credentials, two different people, chosen by
the key alone.

5. Close the browser and reopen http://localhost:3300/login.

**Expect:** the key is still there — it is stored on the device, so the office enters it once and
never again.

### 1b — the same thing from the command line

```bash
# ALPHA's key
curl -s -X POST http://localhost:3100/api/v1/auth/login \
  -H 'content-type: application/json' \
  -H 'x-license-key: vf_c5282dd547579df7aa5b70d0627db834056b6a2c' \
  -d '{"userNumber":"admin@admin.com","password":"testpass1234"}' | jq '.data.user.name'

# BETA's key — same username, same password
curl -s -X POST http://localhost:3100/api/v1/auth/login \
  -H 'content-type: application/json' \
  -H 'x-license-key: vf_839c870970267e6e985be43c808ff72bfc37ba16' \
  -d '{"userNumber":"admin@admin.com","password":"testpass1234"}' | jq '.data.user.name'
```

**Expect:** `"Alpha Admin"` then `"Beta Admin"`. Same credentials, two different people, chosen
by the key.

**Then remove the key entirely** and run it again: you get `Invalid credentials`, because with no
key the request falls back to the `DEFAULT` company, where that user does not exist.

---

## Test 2 — one company cannot see another's data

**The point:** isolation is enforced by Postgres, not by application code. Even a bug in a query
cannot leak across companies.

Both companies have a customer numbered `C-001`:

```bash
docker compose -f docker-compose.suite.yml --env-file .env.suite exec cashvan-db \
  psql -U cashvan -d cashvan -c \
  "SELECT t.code, c.customer_number, c.customer_name
     FROM customers c JOIN tenants t ON t.id=c.tenant_id
    WHERE c.customer_number='C-001';"
```

**Expect:** two rows — `ALPHA → Alpha Shop` and `BETA → Beta Grocery`.

Now ask the database what each company can actually *see*, as the application role:

```bash
docker compose -f docker-compose.suite.yml --env-file .env.suite exec \
  -e PGPASSWORD=cashvan_app_local_pw cashvan-db \
  psql -U cashvan_app -h 127.0.0.1 -d cashvan -c "
BEGIN;
SELECT set_config('app.tenant_id',(SELECT id::text FROM tenants WHERE code='ALPHA'),true);
SELECT customer_name FROM customers WHERE customer_number='C-001';
ROLLBACK;"
```

**Expect:** exactly one row, `Alpha Shop`. Swap `ALPHA` for `BETA` and you get `Beta Grocery`.
One table, one query, different answers — that is row-level security doing the work.

---

## Test 3 — make a new customer, start to finish

**The point:** a customer goes from not existing to signing in, in about a minute, without you
touching a database or copying an id anywhere.

**Sign in** to http://localhost:3400 as `admin@7software.local` / `platform1234`.

### Step 1 — create the company

**Companies** in the left menu → **New company**. Fill in five boxes:

| Box | Type |
|---|---|
| Code | `MYTEST` |
| Name | `My Test Co` |
| Admin email | `boss@mytest.local` |
| Admin name | `Test Boss` |
| Admin password | anything **12 characters or longer** |

Press **Create**.

**Expect:** a green box naming the admin you just made, and a button **Open the company**. Press it.

*(You are not asked to copy anything. If you are, you are on an old build — rebuild the CRM.)*

### Step 2 — put it into cash-van

You are now on the company page. Look at **Put it into a product**:

- **Admin** is already filled in with **Test Boss — boss@mytest.local**. That is the person from
  step 1. If a company had several people you would pick from the list; with one, it is chosen
  for you.
- **Password they will sign in with** — type a new one. This is *not* the password from step 1.
  We only ever kept a scrambled copy of that one, so there is nothing we could pass along. This
  is the password the customer will actually use in the van dashboard.

Press **Provision cash-van**.

**Expect:** a green panel at the top with the **licence key**, like `vf_1e1700db…`. Copy it.

If the customer ever loses it you can get it back: in the **Licences** list further down the same
page, press **Show key**. Keys are stored encrypted for exactly that reason — the alternative
would be issuing a new key and re-keying every browser and phone the customer owns.

Scroll down and check the page filled itself in:

- **Where this company exists** → `cashvan · provisioned`, with the id cash-van gave it
- **People** → Test Boss, `boss@mytest.local`, role `crm: admin`
- **Licences** → the new key, active, with its features as green chips

### Step 3 — sign in as the new customer

Open http://localhost:3300/login. Paste the key into the licence box.

**Expect:** **Signing in to My Test Co**.

Log in with `boss@mytest.local` and the password from **step 2**.

**Expect:** you are inside a company that did not exist three minutes ago, with nothing in it yet.

### Step 4 — delete it again

Back on the company page in the CRM, scroll to the bottom: **Danger zone** → **Delete company**.
Type `MYTEST` to confirm, press **Delete company**.

**Expect:** it disappears from the list, its key stops working, and the email is free so you can
create `MYTEST` again.

**What delete does not do:** it cannot reach into cash-van and remove the company that was made
there. Those are separate databases. What it does is kill every key, so anything left behind is
unreachable rather than exposed. **For a real customer who is leaving, suspend instead** — their
data stays reachable to them while the account is settled.

The platform company cannot be deleted at all. It is how you sign in to the CRM.

---

## Test 4 — stop a customer who has not paid

**The point:** suspension blocks changes but leaves the customer's own data readable. A customer
locked out of their own accounting records escalates; one who can still read and export them pays.

In the CRM dashboard, press **Manage** on the company, find its licence, and press **Suspend**.

**Wait ~60 seconds.** Entitlements are cached for a minute, so a suspension is not instant.

Then:

```bash
KEY=vf_839c870970267e6e985be43c808ff72bfc37ba16   # BETA

# Login — should STILL work
curl -s -X POST http://localhost:3100/api/v1/auth/login -H 'content-type: application/json' \
  -H "x-license-key: $KEY" \
  -d '{"userNumber":"admin@admin.com","password":"testpass1234"}' | jq '.data.user.name'

# A write — should be refused
TOKEN=<accessToken from above>
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3100/api/v1/customers \
  -H 'content-type: application/json' -H "x-license-key: $KEY" \
  -H "authorization: Bearer $TOKEN" \
  -d '{"customerName":"Should Fail","nameAr":"اختبار"}'
```

**Expect:** login succeeds, the write returns **402** with code `license_inactive`.

Set the status back to `active`, wait a minute, and the write returns 201.

---

## Test 5 — sell or withdraw one feature

**The point:** you can disconnect *part* of the service, not just all of it.

BETA's key deliberately excludes `ai` and `prospecting`. Log in with BETA's key, take the token,
then:

```bash
KEY=vf_839c870970267e6e985be43c808ff72bfc37ba16
for path in invoices collections ai/insights prospecting/prospects; do
  printf "%-24s %s\n" "$path" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3100/api/v1/$path" \
        -H "x-license-key: $KEY" -H "authorization: Bearer $TOKEN")"
done
```

**Expect:** `invoices` and `collections` return 200; `ai/insights` and `prospecting/prospects`
return **403** with code `feature_not_licensed`.

Now sell them the AI add-on: in the CRM dashboard, under that licence, click the **ai** chip to
turn it on.

Wait a minute, re-run the loop. `ai/insights` is now 200 and `prospecting` is still 403. No
deploy, no restart — one click in the CRM changed what the customer can reach.

**In the dashboard, the menu follows.** Sign in with **BETA's key** and the **AI assistant**,
**AI insights**, **Prospecting** and **Tax** entries are simply not in the sidebar — the company
did not buy them, so it is never shown a screen that could only refuse it. Sign in with
**ALPHA's key**, which has everything, and all four are there. Turn a feature on in the CRM, wait
a minute, reload, and its entry appears.

> The menu is a courtesy, not the lock — the server refuses those routes on its own, so typing
> the URL directly still gets a 403.
>
> **Testing note that will otherwise waste your afternoon:** sign in with a real licence key. With
> **no** key the dashboard is a single-company install — nothing is licensed, nothing is gated,
> and every menu entry shows. That looks exactly like the gating has failed, when it has not been
> asked to do anything at all.

---

## Test 6 — the ERP

**The point:** one company created in the CRM exists in the ERP too.

```bash
docker compose -f docker-compose.suite.yml --env-file .env.suite exec erp-db \
  psql -U postgres -d erp_database -c \
  "SELECT name, crm_tenant_id FROM organizations;"
```

**Expect:** `Full Suite Co` with a `crm_tenant_id` — that is the link back to the CRM.

To provision another, press **Provision ERP** in the same Manage panel. Then open
http://localhost:3500/login and sign in as that admin.

---

## Test 7 — your existing on-premise customers are untouched

**The point:** every customer you have today runs their own cash-van and their own Postgres on a
machine at their own site. None of them has a licence key, none of them can reach the CRM, and
none of them should notice any of this. That is the result this test protects.

Those installs have **no CRM configured at all**. The API says so, and the dashboard then stops
asking for a key entirely — there is no field to leave blank and get wrong.

```bash
# What an on-premise install answers. licensingEnabled: false = not centrally licensed.
docker compose -f docker-compose.suite.yml --env-file .env.suite exec -T cashvan-api \
  sh -c 'echo "CRM_BASE_URL is: ${CRM_BASE_URL:-<unset — this would be an on-prem install>}"'
```

To see the on-premise behaviour on this machine, the closest thing available is signing in
without a key:

```
http://localhost:3300/login   →   clear the licence box (press تغيير / Change)   →   admin / admin1234
```

**Expect:** signs in to the `DEFAULT` company, behaves exactly as it always has, and **every**
menu entry is present — no feature is hidden, because nothing is licensing it.

**Deploying a real on-premise site** is a one-line difference: leave `CRM_BASE_URL` unset. The
licence guard then does nothing, `GET /auth/license` returns `licensingEnabled: false`, and the
dashboard hides the key field. A site with no internet keeps working, for ever, with no call to
anything of ours.

> Still to build for these customers: recording them in the CRM for support and billing
> visibility (`deployment: onprem`, with their static IP) without the CRM ever being needed for
> them to log in. See Phase 7 in the plan.

---

## What is deliberately NOT testable yet

- **The ERP is not licence-gated.** It is provisioned by the CRM and linked by `crm_tenant_id`,
  but it does not yet check a licence key or features the way cash-van does. It also has no
  licence field of its own, so an ERP user still signs in the way they always did.
- **The mobile app does not send a key.** Reps are still bound to one install. The device
  activation flow that would bind a phone to a company is designed but not built.
- **On-premise licences.** A site with no internet cannot reach the CRM to validate a key. That
  needs a signed offline licence with an expiry, and is not built.

## Teardown

```bash
docker compose -f docker-compose.suite.yml --env-file .env.suite down -v
```
