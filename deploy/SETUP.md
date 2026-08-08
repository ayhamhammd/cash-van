# VanFlow — setup and run

Everything needed to get the four projects running on a clean machine, and the
commands to build and deploy them.

Versions here are the ones the code actually pins, read from `package.json`
engines, the Dockerfiles, `gradle/libs.versions.toml` and the running database —
not "latest".

| project | what it is | dev port |
|---|---|---|
| `ERP` | Next.js 15 + Drizzle — the accounting/inventory system | 3000 |
| `cash-van-dashboard` | NestJS + TypeORM — the backend the vans and dashboard talk to | 3100 |
| `cash-van-dashboard-frontend` | Next.js 15 — the office dashboard | 3001 |
| `FlowVan` | Kotlin Multiplatform — the salesman app (Android + iOS) | — |

---

## 1. Software to install

### Everyone needs

| software | version | why that version |
|---|---|---|
| **Node.js** | **20.x** | every `package.json` says `>=20`, and all three Dockerfiles build on `node:20-alpine`. Node 22 will probably work; nothing has been tested on it |
| **npm** | 10.x (ships with Node 20) | the repos use `package-lock.json` v3 and `npm ci` |
| **PostgreSQL** | **16** | what is running today (16.14). The ERP and cash van use SEPARATE databases on the same server |
| **Git** | any recent | — |

```bash
# macOS
brew install node@20 postgresql@16 git

# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs postgresql-16 git
```

### Only for building the mobile app

| software | version | why |
|---|---|---|
| **JDK** | **17** (toolchain targets Java 11 bytecode) | Android Gradle Plugin 8.11 needs JDK 17+ to *run*; the app compiles *to* Java 11 |
| **Android SDK** | compileSdk **36**, minSdk 24 | `gradle/libs.versions.toml` |
| **Android Studio** | Ladybug or newer | easiest way to get the SDK, emulator and platform-tools |
| **Gradle** | none — use `./gradlew` | the wrapper pins 8.14.3. Never install Gradle separately |
| **Xcode** | 15+ | **macOS only**, and only if you build the iOS target |

### Only for the container deployment

| software | why |
|---|---|
| **Docker** (Desktop, or Engine + Compose v2) | builds and runs the combined suite image |

---

## 2. Database

The ERP and cash van use **two separate databases**. Creating only one is the
most common setup mistake — the second app then starts and fails every query.

```bash
# macOS: start the server first
brew services start postgresql@16
# If `brew services` errors with "undefined method 'stop_timeout'" (a Homebrew
# bug, not a Postgres one), start it directly instead:
pg_ctl -D /opt/homebrew/var/postgresql@16 -l /opt/homebrew/var/log/postgresql@16.log start
```

```bash
createdb flowvan        # cash van backend
createdb erp_flowvan    # ERP
```

If Postgres refuses to start with `lock file "postmaster.pid" already exists`,
check the named PID is really Postgres before removing anything — after an
unclean shutdown the OS often recycles that PID to an unrelated process:

```bash
pgrep -fl postgres            # nothing listed → the lock is stale
ps -p <PID_FROM_THE_ERROR>    # not postgres → the lock is stale
mv /opt/homebrew/var/postgresql@16/postmaster.pid{,.stale}
```

---

## 3. Environment files

Copy each example and fill it in. **Nothing has a safe default** — see the note
on `DB_*` below.

```bash
cp ERP/.env.example                          ERP/.env
cp cash-van-dashboard/.env.example           cash-van-dashboard/.env
cp cash-van-dashboard-frontend/.env.example  cash-van-dashboard-frontend/.env
```

**ERP** (`ERP/.env`) — one connection string:

```
DATABASE_URL=postgresql://USER:PASS@localhost:5432/erp_flowvan
SESSION_SECRET=<32+ random chars>
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

**Backend** (`cash-van-dashboard/.env`) — discrete parts, **not** a URL:

```
PORT=3100
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=<user>
DB_PASSWORD=<pass>
DB_NAME=flowvan
JWT_SECRET=<32+ random chars>
CORS_ORIGINS=http://localhost:3001
```

> The backend falls back to `localhost` / `cashvan` when `DB_*` is unset. It
> then **boots successfully and fails every request** — a container that looks
> healthy and serves nothing. Always set them explicitly.

**Dashboard** (`cash-van-dashboard-frontend/.env`) — these are compiled into the
browser bundle at build time, so they are the URLs the **browser** uses, not the
server's:

```
NEXT_PUBLIC_API_BASE_URL=http://localhost:3100/api/v1
NEXT_PUBLIC_WS_URL=http://localhost:3100
NEXT_PUBLIC_DEFAULT_LOCALE=ar
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=<key>   # optional; only maps degrade without it
```

Changing a `NEXT_PUBLIC_*` value requires a **rebuild**, not a restart.

---

## 4. Install and run — development

Run each in its own terminal.

```bash
# ── Backend  → http://localhost:3100 ─────────────────────────────────────────
cd cash-van-dashboard
npm ci
npm run migration:run        # required; creates/updates every table
npm run seed                 # optional: demo data + the admin user
npm run start:dev
```

```bash
# ── ERP  → http://localhost:3000 ─────────────────────────────────────────────
cd ERP
npm ci
npm run db:migrate           # use db:push ONLY on a throwaway database
npm run dev
```

```bash
# ── Office dashboard  → http://localhost:3001 ────────────────────────────────
cd cash-van-dashboard-frontend
npm ci
npm run dev -- -p 3001
```

Start order matters once: run the backend's migrations before the dashboard, or
its first screens 500 against tables that do not exist yet.

The seed creates an `admin` user with a well-known default password — read it
from `src/database/seeds`. It exists so a fresh checkout can be logged into, and
it is safe only on a development machine.

**Change it before any deployment reachable by anyone else.** The default is
public in this repo, so on a client's server it is not a password.

---

## 5. Mobile app

```bash
cd FlowVan
./gradlew :composeApp:assembleDebug          # build the APK
./gradlew :composeApp:installDebug           # build + install on a connected device
./gradlew :composeApp:compileKotlinIosSimulatorArm64   # iOS compiles (macOS)
```

The app talks to the **backend**, not the ERP. On a physical phone
`localhost` is the phone — point it at the machine's LAN address (e.g.
`http://192.168.1.10:3100`) in the app's settings screen.

```bash
adb devices                  # confirm the phone is attached
adb logcat | grep KtorHTTP   # watch its API calls while testing
```

---

## 6. Verify

```bash
curl -s http://localhost:3100/api/v1/health        # backend
curl -sI http://localhost:3000 | head -1           # ERP
curl -sI http://localhost:3001 | head -1           # dashboard
```

Before pushing changes, each project has its own gate:

```bash
cd cash-van-dashboard           && npx tsc --noEmit && npx jest src
cd cash-van-dashboard-frontend  && npm run typecheck && npm run lint && npm test
cd FlowVan                      && ./gradlew :composeApp:compileDebugKotlinAndroid
```

---

## 7. Deployment — the combined image

One image runs ERP + backend + dashboard, for a client on a single box.
Built from the **parent** directory, because one image needs all three sources.

```bash
cd /path/to/7Software
docker build -f Dockerfile.suite -t vanflow-suite:latest .
```

```bash
docker run -d --name vanflow \
  -p 3000:3000 -p 3001:3001 -p 3100:3100 \
  -e DATABASE_URL="postgresql://USER:PASS@host.docker.internal:5432/erp_flowvan" \
  -e SESSION_SECRET="<32+ chars>" \
  -e DB_HOST=host.docker.internal -e DB_PORT=5432 \
  -e DB_USERNAME=USER -e DB_PASSWORD=PASS -e DB_NAME=flowvan \
  -e JWT_SECRET="<32+ chars>" \
  -e GOOGLE_MAPS_API_KEY="<key>" \
  --restart unless-stopped \
  vanflow-suite:latest
```

`host.docker.internal` reaches the host's Postgres from inside the container. On
Linux add `--add-host=host.docker.internal:host-gateway`, or point at the
database server directly.

```bash
docker logs -f vanflow             # all three services log here, prefixed [suite]
docker inspect --format='{{.State.Health.Status}}' vanflow
```

The entrypoint **refuses to start** if any required variable is missing, and
names them. The container exits if any one of the three services dies, so
`--restart unless-stopped` brings the set back rather than leaving a container
that is "up" with a dead API.

Migrations do **not** run automatically — run them against the databases before
first start, and after any upgrade.

### Why one image, and when not to

Right for a single on-prem box: one `docker run`, one thing to monitor. Wrong
for cloud, because the three share a lifecycle — any one crashing takes all
three down, and none can be restarted or scaled alone. For that, use the three
projects' own Dockerfiles with a compose file.

---

## 8. Things that will bite you

**Two databases, not one.** `flowvan` and `erp_flowvan`. Creating one and
pointing both apps at it fails in confusing ways.

**Different DB config styles.** The ERP wants `DATABASE_URL`; the backend wants
`DB_HOST`/`DB_NAME`/`DB_USERNAME`/`DB_PASSWORD`. Setting only one is silent —
see the warning in §3.

**All three default to port 3000** on their own. In development you must pass
`-p 3001` to the dashboard; in the container the entrypoint assigns them.

**`NEXT_PUBLIC_*` is baked at build time.** Changing the API URL for the
dashboard means rebuilding it, not restarting it.

**ERP sync is a setting, not an env var.** It lives in the backend's app
settings (Settings → ERP: base URL + API key). With it off, documents queue in
the outbox and nothing reaches the ERP.

**`npm ci`, never `npm install`,** for reproducible builds — the lockfiles are
committed and the Dockerfiles rely on them.
