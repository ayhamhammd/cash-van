# VanFlow — required software

What must be installed on a **client Windows desktop** to run the VanFlow suite
image, and what a **developer** additionally needs to build it.

Versions are the ones the code pins — read from `package.json` engines, the
Dockerfiles, `gradle/libs.versions.toml` and the running database. Not "latest".

---

## A. Client desktop — to RUN the system

Three things. Nothing else.

| # | Software | Version | Where | Notes |
|---|---|---|---|---|
| 1 | **Docker Desktop for Windows** | 4.x current | docker.com/products/docker-desktop | Must run in **Linux container** mode |
| 2 | **WSL 2** | — | `wsl --install` then reboot | Docker Desktop's backend. Usually installed by Docker's own installer |
| 3 | **PostgreSQL** | **16** | postgresql.org/download/windows | **Not in the image** — see below |

### Windows itself

| | Minimum | Why |
|---|---|---|
| Edition | Windows 10 **build 19041** (2004) or Windows 11 | WSL 2 needs it |
| Architecture | 64-bit | Docker Desktop requirement |
| RAM | 8 GB (4 GB absolute minimum) | Three Node apps plus PostgreSQL |
| Free disk | 20 GB | The image plus WSL's virtual disk, which grows and never shrinks on its own |
| BIOS/UEFI | **Virtualisation enabled** (Intel VT-x / AMD-V) | The most common blocker: Docker installs fine, then refuses to start |

### PostgreSQL is not optional, and not included

The image ships the ERP, the backend and the dashboard. It contains **no
database**. PostgreSQL 16 must be reachable — on the same desktop or on a
server — with **two databases**:

```
flowvan        <- cash van backend
erp_flowvan    <- ERP
```

Two, not one. Pointing both applications at a single database fails in ways that
look like software bugs rather than a setup mistake.

### Ports that must be free

| Port | Service |
|---|---|
| 3000 | ERP |
| 3001 | Office dashboard |
| 3100 | Backend API |
| 5432 | PostgreSQL |

### Optional

| Software | When you need it |
|---|---|
| **Google Maps API key** | Only for map views in the dashboard. Everything else works without it |
| A modern browser | Chrome or Edge. Both ship with Windows-era machines already |

> Run `windows-preflight.ps1` on the client machine to check all of the above
> automatically before installing.

---

## B. Developer machine — to BUILD the system

Everything in section A, plus:

| Software | Version | Why that version |
|---|---|---|
| **Node.js** | **20.x** | Every `package.json` says `>=20`; all three Dockerfiles build on `node:20-alpine` |
| **npm** | 10.x (ships with Node 20) | Lockfiles are v3; builds use `npm ci` |
| **Git** | any recent | — |

### Additionally, only for the salesman app (FlowVan)

| Software | Version | Why |
|---|---|---|
| **JDK** | **17** | Android Gradle Plugin 8.11 needs 17+ to run (the app itself compiles to Java 11 bytecode) |
| **Android Studio** | Ladybug or newer | Simplest way to get the SDK, emulator and platform-tools |
| **Android SDK** | compileSdk **36**, minSdk 24 | From `gradle/libs.versions.toml` |
| **Gradle** | **do not install** | The repo's `./gradlew` pins 8.14.3. Installing Gradle separately causes version mismatches |
| **Xcode** | 15+ | **macOS only**, and only to build the iOS target |

---

## C. Install order

Order matters in two places, both of which waste an afternoon if reversed.

1. **Enable virtualisation in BIOS/UEFI** — before anything else. Docker Desktop
   installs happily without it and then will not start.
2. **WSL 2** — `wsl --install`, then **reboot**.
3. **Docker Desktop** — then confirm the tray icon says *Linux containers*.
4. **PostgreSQL 16** — then create both databases:
   ```
   createdb -U postgres flowvan
   createdb -U postgres erp_flowvan
   ```
5. **Run the database migrations** — they do not run automatically on container
   start. See `SETUP.md` §7.
6. **Start the container.**

---

## D. What you do NOT need on the client

Listed because they are commonly installed "just in case" and are not required:

- **Node.js** — the apps run inside the container, which brings its own
- **IIS, Apache or nginx** — the three apps serve their own HTTP
- **.NET, Java or Python** — nothing in the suite uses them
- **Hyper-V explicitly** — WSL 2 is the backend; Docker enables what it needs
- **Android Studio or the SDK** — building the phone app is a developer task

---

## E. Air-gapped clients

Where the desktop cannot reach the Docker registry, move the image as a file:

```bash
# on a machine that has the image
docker save vanflow-suite:latest -o vanflow-suite.tar
```

```powershell
# on the client
docker load -i vanflow-suite.tar
```

PostgreSQL's Windows installer is a normal offline `.exe`, so it needs no
special handling.
