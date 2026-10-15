# Moving a client to a new server and a new IP

Written for **77.245.5.113 → a new static IP**. The same steps fit any client.

Set the two addresses once, at the top of your PowerShell session on whichever
machine you are working on, and every command below uses them:

```powershell
$OLD = "77.245.5.113"
$NEW = "PUT.THE.NEW.IP.HERE"
```

---

## What actually has to change

Most of the stack does not care about the address. Two things do.

| | Moves unchanged? | Why |
|---|---|---|
| `cashvan-api` image | **yes** | host-agnostic |
| `vanflow-dashboard` image | **yes** | built with relative `/api/v1`, calls whatever host served it |
| Postgres images + data | **yes** | dump and restore |
| `erp-app` / `erp-migrate` images | **NO — rebuild** | `NEXT_PUBLIC_APP_URL` is baked in at build time |
| Caddyfile | **NO — new copy** | sslip.io hostnames *are* the IP, so every hostname names the old machine |

From `deploy/DEPLOY-77.245.5.113.md`: *"Both images below are host-agnostic and
deploy unchanged to either server. Each client needs its own Caddyfile — but
only that."* That is true of VanFlow. The ERP is the exception, because its
baked URL is what printed QR and "verify" links point at.

---

## The part that silently destroys data

**Four secrets must move verbatim.** They are not configuration; they are keys
that existing rows were written with. Generate new ones and the data is still
there but unreadable:

| Secret | What breaks if it changes |
|---|---|
| `JOFOTARA_KMS_KEY` | Every stored JoFotara credential becomes undecryptable. It reads as *unset*, not as an error, so the failure is silent. |
| `JWT_SECRET` | Sessions drop — expected. But it is also the **fallback** encryption key when `JOFOTARA_KMS_KEY` is absent, so on a server that never set the KMS key, changing it destroys the same secrets. |
| `PHONE_HASH_SECRET` | `customers.phone_hash` no longer matches any phone number. Lookup by phone stops finding anybody. |
| `SALESMAN_ACTIVATION_SECRET` | Seat licensing keys stop validating; reps arrive frozen and cannot be keyed. |

Copy the old `.env` across as a file. Do not retype it, and do not "refresh"
anything while you are in there.

`DB_PASSWORD` must match what you restore into — either carry it over, or set
the role's password on the new database to match the env.

---

## 1. Inventory the old server

Run on the old machine, in the compose folder (`D:\7Software\cashvan`):

```powershell
docker compose config > D:\7Software\cashvan\compose-resolved.yml
docker ps --format "table {{.Names}}`t{{.Image}}`t{{.Ports}}"
docker volume ls
```

Note every published port and every named volume. Keep
`compose-resolved.yml` — it is the compose file with all variables already
substituted, which is the clearest record of what was running.

## 2. Back up both databases

```powershell
docker exec cashvan-db pg_dump -U cashvan -Fc cashvan -f /tmp/cashvan.dump
docker cp cashvan-db:/tmp/cashvan.dump D:\7Software\cashvan\migrate\cashvan.dump
```

```powershell
docker exec erp-db pg_dump -U erp -Fc erp_database -f /tmp/erp.dump
docker cp erp-db:/tmp/erp.dump D:\7Software\cashvan\migrate\erp.dump
```

Check the sizes look like the real databases, not a few kilobytes.

## 3. Take the uploads with you

Customer photos, attachments and agent reports live on a mounted volume, not in
Postgres. A migration that forgets this loses every photo a rep ever took.

```powershell
docker run --rm -v cashvan_storage:/from -v D:\7Software\cashvan\migrate:/to alpine tar czf /to/storage.tgz -C /from .
```

Replace `cashvan_storage` with the real volume name from step 1.

## 4. Copy to the new server

Move the whole folder: `docker-compose.yml`, `.env` (both, if the ERP has its
own), the `migrate\` dumps, `storage.tgz`, and the Caddy config directory.

## 5. New Caddyfile for the new IP

Copy `deploy/caddy/Caddyfile.client-77.245.5.113` to a new file named for the
new IP, and replace every hostname:

```
https://$NEW.sslip.io          → ERP
https://app.$NEW.sslip.io      → VanFlow dashboard + API (one origin)
```

**Ports 80 and 443 must be reachable from the internet** on the new server, or
Let's Encrypt cannot issue a certificate — it connects back on port 80 to
verify. Open both on the Windows firewall *and* the router before starting
Caddy, and point the new static IP's DNS/routing at the machine first.

## 6. Rebuild the ERP image for the new address

On a build machine with the ERP repo:

```bash
NEXT_PUBLIC_APP_URL=https://$NEW.sslip.io ./scripts/build-windows-bundle.sh
```

That env var is **required**. Without it the script bakes in its default,
which is the old client — and invoice QR / verify links would point at a
server this customer no longer owns.

Copy `dist-windows/erp-images.tar.gz` to the new server and `docker load` it.

## 7. Restore

Start only the databases first, so nothing writes while you restore:

```powershell
docker compose up -d cashvan-db erp-db
```

```powershell
docker cp D:\...\migrate\cashvan.dump cashvan-db:/tmp/cashvan.dump
docker exec cashvan-db pg_restore -U cashvan -d cashvan --clean --if-exists /tmp/cashvan.dump
```

```powershell
docker cp D:\...\migrate\erp.dump erp-db:/tmp/erp.dump
docker exec erp-db pg_restore -U erp -d erp_database --clean --if-exists /tmp/erp.dump
```

Then the uploads:

```powershell
docker run --rm -v cashvan_storage:/to -v D:\...\migrate:/from alpine sh -c "tar xzf /from/storage.tgz -C /to"
```

## 8. Start everything

```powershell
docker compose up -d
```

`erp-migrate` runs on start. If the new ERP image is newer than the old
server's, it applies migrations — which is fine, but it is a schema change on
freshly restored data, so the dumps from step 2 are your only way back.

## 9. Repoint the things that still name the old server

This is the step that gets forgotten, and the symptoms appear days later.

**VanFlow's ERP connection.** The ERP base URL is stored in VanFlow
**Settings**, in the database — so it came across in the dump still pointing at
the old IP. Update it to `https://$NEW.sslip.io`, or every push fails.

**The handsets.** Each van's app points at the old address. They need the new
one before the reps can sync.

**Anything else holding the old hostname**: bookmarks, a JoFotara portal
registration, printed QR codes already issued (those cannot be changed — the
old URL is on paper), and any external integration.

## 10. Verify, in this order

```powershell
docker ps --format "table {{.Names}}`t{{.Status}}"
```

Everything `healthy` or `Up`.

```powershell
docker exec erp-app sh -c "grep -rl '$NEW' .next | head -3"
```

The new IP is baked into the ERP bundle. Then check the **old** one is gone:

```powershell
docker exec erp-app sh -c "grep -rl '$OLD' .next | head -3"
```

That should return nothing. If it returns files, the image was built with the
wrong URL and the QR links are wrong.

```powershell
docker exec cashvan-db psql -U cashvan -d cashvan -c "SELECT (SELECT count(*) FROM customers) AS customers, (SELECT count(*) FROM voucher_headers) AS vouchers, (SELECT count(*) FROM reps) AS reps;"
```

```powershell
docker exec erp-db psql -U erp -d erp_database -c "SELECT (SELECT count(*) FROM customers) AS customers, (SELECT count(*) FROM invoices) AS invoices, (SELECT count(*) FROM chart_of_accounts) AS accounts;"
```

Compare against the same counts taken on the old server **before** you started.

Then, in a browser: `https://app.$NEW.sslip.io` must load over HTTPS, log in,
and show customers. And `https://$NEW.sslip.io` must load the ERP.

Finally the real test — take one sale on a handset and confirm it reaches the
ERP as a voucher with the right van cash box.

## 11. Keep the old server for a week

Do not wipe it. Stop its containers so nothing writes, but leave the data:

```powershell
docker compose stop
```

If something is discovered missing a week later, it is still there.

---

## Decide before you start

**The IP is in printed documents.** Any invoice QR already given to a customer
points at the old address. If the old server is turned off, those stop
resolving. Either keep the old machine answering that hostname, or accept that
historical QR links break — a decision for whoever owns the tax compliance,
not a technical one.

**Pick a quiet window.** Reps cannot sell while the handsets point at a server
that is moving. An evening after the day closing is the natural moment.
