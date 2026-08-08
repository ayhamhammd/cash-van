# Running the suite on Windows without Docker

ERP + backend + dashboard as three native Windows services. No container, no
WSL2, no virtualisation in BIOS — which is what made this route worth taking.

Everything below was checked against the code, and the two claims most likely to
be got wrong were tested against a running build rather than reasoned about.

---

## 1. Install

| | version | note |
|---|---|---|
| **Node.js** | **20.x LTS** | every `package.json` says `>=20` |
| **PostgreSQL** | **16** | two databases, see §4 |
| **Git** | any | |
| **NSSM** | 2.24-101 (the CI build) | turns each app into a real Windows service |
| **Caddy** | 2.x, `caddy_windows_amd64.exe` | HTTPS. Native binary, not the Docker image |

Do this before anything else, or the first command you run fails:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

PowerShell resolves `npm.ps1` before `npm.cmd`, and the default policy blocks
it. The error says npm cannot be loaded, which reads like a broken Node install.

Long paths, because `@carbon/react` in the ERP nests past 260 characters:

```powershell
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' LongPathsEnabled 1
git config --system core.longpaths true
```

Reboot after that, and install at a **short root** — `C:\vanflow`, not
`C:\Users\...\Documents\...`.

---

## 2. Layout

```
C:\vanflow\
├── ERP\                          :3000
├── backend\                      :3100   (cash-van-dashboard)
├── dashboard\                    :3001   (cash-van-dashboard-frontend)
├── data\storage\                         backend uploads — OUTSIDE every repo
├── caddy\                                caddy.exe, Caddyfile, data\, config\
└── logs\
```

`data\storage` sits outside the repos deliberately. `STORAGE_LOCAL_ROOT`
defaults to `./storage`, which under a service resolves inside the backend's
working tree — where the upgrade in §8 runs `git pull`.

---

## 3. Environment

Two files. **Neither app reads the other's.**

**`C:\vanflow\backend\.env`**

```ini
NODE_ENV=production
PORT=3100
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=<db password>
DB_NAME=flowvan
JWT_SECRET=<32+ random chars>
PDA_TOKEN_SECRET=<32+ random chars>
PHONE_HASH_SECRET=<32+ random chars>
JOFOTARA_KMS_KEY=<32+ random chars>
CORS_ORIGINS=https://app.<your-host>
STORAGE_LOCAL_ROOT=C:\vanflow\data\storage
RATE_LIMIT_LIMIT=1000
```

`PORT=3100` is not optional — the backend defaults to **3000** and would fight
the ERP for the port.

`RATE_LIMIT_LIMIT` is raised because the backend never calls
`app.set('trust proxy')`. Behind Caddy every van looks like `127.0.0.1`, so the
whole fleet shares one throttle bucket. The proper fix is one line in `main.ts`;
until then, raise the ceiling or the vans start 429-ing each other in waves.

**`C:\vanflow\ERP\.env`**

```ini
NODE_ENV=production
DATABASE_URL=postgresql://postgres:<db password>@localhost:5432/erp_flowvan
SESSION_SECRET=<32+ random chars>
PDA_TOKEN_SECRET=<32+ random chars>
NEXT_PUBLIC_APP_URL=https://erp.<your-host>
```

**`C:\vanflow\ERP\.env.local`** — one line, nothing else:

```ini
DATABASE_URL=postgresql://postgres:<db password>@localhost:5432/erp_flowvan
```

`drizzle.config.ts` reads `.env.local` and only that. Without it, migrations run
against drizzle's built-in default connection and cheerfully report success
against a database the app never opens.

**The dashboard has no `.env` at runtime.** Every variable it reads is
`NEXT_PUBLIC_*`, and those are compiled into the bundle at build time — §5.

### Two secrets that can never be rotated

`PHONE_HASH_SECRET` orphans every stored phone hash. `JOFOTARA_KMS_KEY` makes
every stored ERP/AI credential undecryptable. Set them once, copy them into the
client's password manager, and never touch them again. `JWT_SECRET` and
`SESSION_SECRET` rotate freely (everyone gets logged out, which is the point).

---

## 4. Databases

Two. Creating one and pointing both apps at it fails in ways that look like
software bugs.

```powershell
$env:PGCLIENTENCODING='UTF8'
psql -U postgres -c "CREATE DATABASE flowvan     ENCODING 'UTF8' TEMPLATE template0;"
psql -U postgres -c "CREATE DATABASE erp_flowvan ENCODING 'UTF8' TEMPLATE template0;"
psql -U postgres -l
```

Encoding is spelled out because `createdb` inherits the cluster's, which on an
Arabic-locale Windows can be WIN1256. This suite is Arabic-first — get this
wrong and every screen renders mojibake, or the seed refuses to load at all.

---

## 5. Build

Order matters, and the API URLs must be decided **before** you build.

```powershell
cd C:\vanflow\backend
npm ci
npm run build

cd C:\vanflow\ERP
npm ci
npm run build

cd C:\vanflow\dashboard
npm ci
$env:NEXT_PUBLIC_API_BASE_URL = "https://api.<your-host>/api/v1"
$env:NEXT_PUBLIC_WS_URL       = "https://api.<your-host>"
$env:NEXT_PUBLIC_DEFAULT_LOCALE = "ar"
npm run build
```

**`NEXT_PUBLIC_*` is inlined at compile time.** Changing the dashboard's API URL
later is a rebuild, not a restart and not a config edit. Build it with the
`https://` Caddy hostnames from the start: build it with a `http://192.168.x.x`
address and the browser blocks every call as mixed content once Caddy is in
front — the page loads over HTTPS and then silently does nothing.

`npm ci`, not `npm install` — and do not set `--omit=dev`, since `next build`
needs TypeScript. If a machine-scope `NODE_ENV=production` is already set, npm
omits dev dependencies no matter what you do in the shell:

```powershell
[Environment]::GetEnvironmentVariable('NODE_ENV','Machine')   # expect blank
```

---

## 6. Migrate, then seed

Never with the services running.

```powershell
cd C:\vanflow\backend
npm run migration:run

cd C:\vanflow\ERP
npm run db:migrate
```

Both work on a normal install. The backend's script runs through `ts-node`
against `src/`, so it needs the dev dependencies you already installed; the
ERP's `drizzle-kit` is a **runtime** dependency, so it survives even a pruned
install.

If you ever do prune the backend, migrate against the compiled data source
instead:

```powershell
npx typeorm migration:run -d dist\database\data-source.js
```

Then seed, or there is no account to log in with — and the backend's seed also
inserts the transaction kinds (`SALE`, `RETURN`, `TRANSFER_IN`…) that the
vouchers module looks up at runtime. Skip it and voucher operations fail much
later with foreign-key errors that look nothing like a missing seed.

```powershell
cd C:\vanflow\backend ; npm run seed
```

Change the seeded password immediately. It is published in a public repo, so on
a reachable server it is not a password.

---

## 7. Run as services

### Use `npm start`, not the standalone bundle

Both Next apps set `output: "standalone"`, and `next start` prints:

```
⚠ "next start" does not work with "output: standalone" configuration.
```

**It is advisory. `next start` works.** Verified on a real build — page, JS
chunk and CSS all returned 200.

Use it, and do **not** copy `.next/standalone` around on Windows. Two reasons,
both verified on the ERP as it stands today:

- `server.js` calls `process.chdir(__dirname)`, so the ERP's `process.cwd()`
  paths — `public/uploads`, `private-uploads`, the customer manual — resolve
  *inside* `.next\standalone`.
- `cleanDistDir` is `true`, so **`next build` deletes `.next` wholesale**. There
  are already **19 customer images** sitting in
  `ERP\.next\standalone\public\uploads` on the dev machine. One rebuild and they
  are gone, with no error and no recovery.

### Register the services

```powershell
$nssm = "C:\vanflow\bin\nssm.exe"

& $nssm install VanFlow-Backend "C:\Program Files\nodejs\node.exe" "dist\main.js"
& $nssm set VanFlow-Backend AppDirectory C:\vanflow\backend
& $nssm set VanFlow-Backend AppStdout C:\vanflow\logs\backend.log
& $nssm set VanFlow-Backend AppStderr C:\vanflow\logs\backend.err.log
& $nssm set VanFlow-Backend AppRotateFiles 1

& $nssm install VanFlow-ERP "C:\Program Files\nodejs\node.exe" "node_modules\next\dist\bin\next start -p 3000 -H 127.0.0.1"
& $nssm set VanFlow-ERP AppDirectory C:\vanflow\ERP
& $nssm set VanFlow-ERP AppStdout C:\vanflow\logs\erp.log
& $nssm set VanFlow-ERP AppStderr C:\vanflow\logs\erp.err.log
& $nssm set VanFlow-ERP AppRotateFiles 1

& $nssm install VanFlow-Dashboard "C:\Program Files\nodejs\node.exe" "node_modules\next\dist\bin\next start -p 3001 -H 127.0.0.1"
& $nssm set VanFlow-Dashboard AppDirectory C:\vanflow\dashboard
& $nssm set VanFlow-Dashboard AppStdout C:\vanflow\logs\dashboard.log
& $nssm set VanFlow-Dashboard AppStderr C:\vanflow\logs\dashboard.err.log
& $nssm set VanFlow-Dashboard AppRotateFiles 1

Start-Service VanFlow-Backend, VanFlow-ERP, VanFlow-Dashboard
```

`-H 127.0.0.1` binds the two web apps to loopback so only Caddy can reach them.
**The backend cannot be bound this way** — `main.ts` hardcodes
`app.listen(port, '0.0.0.0')`. Block 3100 at the firewall instead (§9).

NSSM over PM2: these become real Windows services that the Service Control
Manager starts at boot with nobody logged in. PM2's Windows startup story needs
a helper package and a logged-in account, which is exactly what an unattended
client machine does not have.

```powershell
Restart-Service VanFlow-Backend
Get-Content C:\vanflow\logs\backend.err.log -Tail 50 -Wait
```

---

## 8. Caddy, natively

The Caddyfiles in `deploy/caddy/` are **Docker-only** — they proxy to
`host.docker.internal`, which does not exist here. Use this instead, at
`C:\vanflow\caddy\Caddyfile`:

```caddyfile
{
	email admin@7softwarejo.com
}

(security) {
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Frame-Options "DENY"
		X-Content-Type-Options "nosniff"
		-Server
	}
}

# EDIT to the client's real subnet: Get-NetIPAddress -AddressFamily IPv4
(office_only) {
	@public not remote_ip 192.168.1.0/24 127.0.0.1 ::1
	respond @public "Not available from this network" 403
}

erp.<your-host> {
	import security
	import office_only
	reverse_proxy 127.0.0.1:3000
	log { output file C:\vanflow\logs\caddy-erp.log { roll_size 10mb roll_keep 10 } }
}

app.<your-host> {
	import security
	import office_only
	reverse_proxy 127.0.0.1:3001
	log { output file C:\vanflow\logs\caddy-app.log { roll_size 10mb roll_keep 10 } }
}

api.<your-host> {
	import security
	reverse_proxy 127.0.0.1:3100
	log { output file C:\vanflow\logs\caddy-api.log { roll_size 10mb roll_keep 10 } }
}

:443 {
	tls internal
	respond 404
}
```

Register it as a fourth service, pinning its data directory:

```powershell
& $nssm install VanFlow-Caddy C:\vanflow\caddy\caddy.exe "run --config C:\vanflow\caddy\Caddyfile"
& $nssm set VanFlow-Caddy AppDirectory C:\vanflow\caddy
& $nssm set VanFlow-Caddy AppEnvironmentExtra XDG_DATA_HOME=C:\vanflow\caddy\data XDG_CONFIG_HOME=C:\vanflow\caddy\config
Start-Service VanFlow-Caddy
```

Pinning `XDG_DATA_HOME` matters more than it looks. A service runs as
LocalSystem, whose `%AppData%` is under `System32\config\systemprofile` — so
Caddy would keep a *different* certificate store from your interactive test and
re-issue everything. Do that a few times while troubleshooting and Let's Encrypt
locks those hostnames out for **a week**.

While iterating, add `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`
to the global block, and remove it once it works.

**HTTPS is not optional here.** The ERP's session cookie is `secure` whenever
`NODE_ENV=production`, with no override. Over plain HTTP from any machine but
the server itself, login accepts the password, redirects, and lands back on the
login page forever — no error, nothing logged. It works from the server's own
browser because `localhost` counts as trustworthy, so a console-only test
"passes" on a system nobody else can log into. **Verify from a second machine.**

---

## 9. Firewall

```powershell
New-NetFirewallRule -DisplayName "VanFlow HTTP"  -Direction Inbound -LocalPort 80  -Protocol TCP -Action Allow -Profile Any
New-NetFirewallRule -DisplayName "VanFlow HTTPS" -Direction Inbound -LocalPort 443 -Protocol TCP -Action Allow -Profile Any
New-NetFirewallRule -DisplayName "VanFlow block app ports" -Direction Inbound -LocalPort 3000,3001,3100 -Protocol TCP -Action Block -Profile Any
```

`-Profile Any` is deliberate: a router-forwarded connection usually arrives on
the Public profile, so rules scoped to Domain/Private never match and the vans
just time out.

At the router, forward **only 80 and 443**. Port 80 is required for the ACME
challenge. **Never forward 5432.**

---

## 10. Verify

From the server:

```powershell
curl.exe -s http://127.0.0.1:3100/api/v1/health
curl.exe -sI http://127.0.0.1:3000 | Select-Object -First 1
curl.exe -sI http://127.0.0.1:3001 | Select-Object -First 1
```

Then **from a different machine**, which is the only test that counts:

- `https://erp.<your-host>` — log in, and confirm you stay logged in
- `https://app.<your-host>` — open a screen with data, confirm no 401 wall
- `https://api.<your-host>/api/v1/health`

---

## 11. Upgrades

```powershell
Stop-Service VanFlow-Dashboard, VanFlow-ERP, VanFlow-Backend
cd C:\vanflow\ERP ; git stash push -- public/uploads ; git pull ; git stash pop
cd C:\vanflow\backend ; git pull ; npm ci ; npm run build
cd C:\vanflow\ERP ; npm ci ; npm run build
cd C:\vanflow\dashboard ; git pull ; npm ci ; <set NEXT_PUBLIC_*> ; npm run build
cd C:\vanflow\backend ; npm run migration:run
cd C:\vanflow\ERP ; npm run db:migrate
Start-Service VanFlow-Backend, VanFlow-ERP, VanFlow-Dashboard
```

Stopping first is not tidiness. Windows holds file locks on `.next` and `dist`
while node is running, so a build fails partway — and since `cleanDistDir`
already deleted `.next`, you are left with a directory that neither starts nor
rebuilds until you remove it by hand.

The `git stash` around the ERP is protecting real data: `public/uploads` is
**tracked in git**, so `git pull` conflicts on customer document photos, and the
reflex `git checkout .` deletes them permanently. Fix it properly once:

```powershell
cd C:\vanflow\ERP
git rm --cached -r public/uploads
Add-Content .gitignore "`n/public/uploads/"
```

---

## 12. Backups

Nightly, as a SYSTEM scheduled task:

```powershell
$d = Get-Date -Format yyyyMMdd
$env:PGPASSWORD = '<db password>'
& 'C:\Program Files\PostgreSQL\16\bin\pg_dump.exe' -U postgres -Fc -f "D:\backup\flowvan_$d.dump"     flowvan
& 'C:\Program Files\PostgreSQL\16\bin\pg_dump.exe' -U postgres -Fc -f "D:\backup\erp_flowvan_$d.dump" erp_flowvan
robocopy C:\vanflow\ERP\public\uploads  D:\backup\erp-uploads\     /MIR /R:1 /W:1
robocopy C:\vanflow\data\storage        D:\backup\storage\        /MIR /R:1 /W:1
Remove-Item Env:PGPASSWORD
```

A database backup alone is not a backup. Without `PHONE_HASH_SECRET` and
`JOFOTARA_KMS_KEY` a restored database has orphaned phone hashes and
undecryptable credentials — put both in the client's password manager, off the
machine.

Prune logs monthly; NSSM rotates but never deletes, and Caddy's access log on a
public API host is the biggest of them.

---

## 13. Things that will bite

| Symptom | Cause |
|---|---|
| `npm.ps1 cannot be loaded` | execution policy — §1 |
| Login redirects to login, forever, from every machine but the server | ERP cookie is `secure`; you are on HTTP — §8 |
| Dashboard logs in, then every screen empty with 401s | auth cookie needs HTTPS on both dashboard and API |
| Dashboard loads over HTTPS and does nothing; console says mixed content | built with an `http://` API URL — rebuild, §5 |
| Staff get "Not available from this network" 403 | `office_only` subnet still the placeholder — §8 |
| Vans time out on 443 | firewall rule scoped to Domain/Private — §9 |
| Whole fleet 429s in waves | no `trust proxy`; one shared bucket — §3 |
| Arabic renders as mojibake | database not created as UTF8 — §4 |
| `next build` fails with EPERM on `.next` | services still running — §11 |
| Page 200 but no styling, everything 404 | you used the standalone bundle without copying `.next/static` — don't use it, §7 |
| ERP 500s on pages that used to work | drizzle migrated the wrong database; `ERP\.env.local` missing — §3 |

The `.sh` files in these repos (`suite-entrypoint.sh`, the build scripts) are
Docker-only reference material. Do not run them here.
