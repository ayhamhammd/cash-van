# Deploy to a client server from Docker images (offline install)

Build the images **once on your machine**, ship them as files, and run them on the
client server with **no source code and no internet** required on that server.

Covers the **FlowVan Dashboard** (backend API + web dashboard) and the **ERP**
(optional: the Integration Hub). Everything is already dockerized — this is the
build → save → load → run procedure, not new Docker config.

---

## 0. What runs where (port map)

One server runs several containers; each app image listens on **3000** internally,
so we publish them on **different host ports**:

| Service | Image | Host port | Opens in browser |
|---|---|---|---|
| FlowVan API (NestJS) | `cashvan-api:prod` | **3000** | `http://<SERVER-IP>:3000/api/v1` |
| FlowVan Dashboard (Next) | `vanflow-dashboard:latest` | **8080** | `http://<SERVER-IP>:8080` |
| ERP (Next) | `erp:latest` | **3001** | `http://<SERVER-IP>:3001` |
| Integration Hub *(optional)* | `integration-hub:latest` | **3007** | `http://<SERVER-IP>:3007` |
| PostgreSQL (per stack) | `postgres:16(.4)-alpine` | internal only | — |

> Replace `<SERVER-IP>` everywhere with the client server's **fixed LAN IP** (e.g.
> `192.168.1.50`). Give the server a static IP or DHCP reservation first.

### ⚠️ The one thing people get wrong

The **web front-ends bake their URLs at _build_ time** (`NEXT_PUBLIC_*` is compiled
into the browser bundle). You **must** build the dashboard and ERP images with the
client's real IP — you cannot change these by editing `.env` on the server:

- Dashboard → `NEXT_PUBLIC_API_BASE_URL = http://<SERVER-IP>:3000/api/v1`
- Dashboard → `NEXT_PUBLIC_WS_URL = http://<SERVER-IP>:3000`
- ERP → `NEXT_PUBLIC_APP_URL = http://<SERVER-IP>:3001`

If the client IP changes, **rebuild + reship those two images**.

---

## 1. Prerequisites

**Build machine (yours):** Docker Desktop / Docker Engine + the three repos.
**Client server:** Docker Desktop (Windows 10/11) or Docker Engine (Linux). Nothing else.

Verify on both: `docker version` and `docker compose version`.

---

## 2. Build the images (on your machine)

Run from the folder that contains the three repos. Set the client IP once:

```bash
SERVER_IP=192.168.1.50   # ← the client server's LAN IP

# 1) FlowVan API (backend) — self-migrates + seeds on boot
docker build -t cashvan-api:prod --target production ./cash-van-dashboard

# 2) FlowVan Dashboard (web) — URLs are baked in HERE
docker build -t vanflow-dashboard:latest \
  --build-arg NEXT_PUBLIC_API_BASE_URL=http://$SERVER_IP:3000/api/v1 \
  --build-arg NEXT_PUBLIC_WS_URL=http://$SERVER_IP:3000 \
  --build-arg NEXT_PUBLIC_DEFAULT_LOCALE=ar \
  ./cash-van-dashboard-frontend

# 3) ERP (web) — runtime image
docker build -t erp:latest --target runner \
  --build-arg NEXT_PUBLIC_APP_URL=http://$SERVER_IP:3001 \
  ./ERP

# 4) ERP migrator (carries drizzle-kit + migration SQL; used once per deploy)
docker build -t erp-migrator:latest --target builder ./ERP

# 5) (optional) Integration Hub
docker build -t integration-hub:latest ./ERP/integration-hub
```

> Windows PowerShell: use `$SERVER_IP="192.168.1.50"` and `$SERVER_IP` in the args.

Also make sure the Postgres base images are present locally so they travel with the
bundle (no internet on the client):

```bash
docker pull postgres:16.4-alpine   # FlowVan API DB
docker pull postgres:16-alpine     # ERP / Hub DB
```

---

## 3. Export the images to a single file

```bash
docker save \
  cashvan-api:prod vanflow-dashboard:latest \
  erp:latest erp-migrator:latest integration-hub:latest \
  postgres:16.4-alpine postgres:16-alpine \
  | gzip > vanflow-erp-stack.tar.gz
```

You get one `vanflow-erp-stack.tar.gz` (a few hundred MB). Drop the hub images if you
don't need it.

> Windows PowerShell (no `gzip`): `docker save -o vanflow-erp-stack.tar <images...>`
> then zip the `.tar` if you want it smaller.

---

## 4. Transfer to the client server

Copy `vanflow-erp-stack.tar.gz` (and the two compose files + `.env` from step 6) to the
server by **USB drive, network share, or scp**:

```bash
scp vanflow-erp-stack.tar.gz user@<SERVER-IP>:/opt/vanflow/
```

---

## 5. Load the images on the client server

```bash
cd /opt/vanflow
gunzip -c vanflow-erp-stack.tar.gz | docker load
docker images     # confirm cashvan-api, vanflow-dashboard, erp, postgres … are listed
```

> Windows: `docker load -i vanflow-erp-stack.tar`

---

## 6. Configure secrets on the server (`.env`)

Create these two files **next to the compose files** on the server. Generate strong
random secrets (`openssl rand -hex 32`).

`vanflow.env`:
```dotenv
DB_PASSWORD=<strong-db-password>
JWT_SECRET=<64-char-random>
CORS_ORIGINS=http://192.168.1.50:8080
```

`erp.env`:
```dotenv
ERP_DB_PASSWORD=<strong-db-password>
SESSION_SECRET=<64-char-random>
ERP_APP_URL=http://192.168.1.50:3001
```

---

## 7. Compose files for the client (image-only — no build)

These reference the **loaded images**; there is no `build:` so the server never needs
source code. Save them on the server as shown.

`docker-compose.vanflow.yml` — **Dashboard = API + Web + DB**:
```yaml
name: vanflow
services:
  db:
    image: postgres:16.4-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: cashvan
      POSTGRES_PASSWORD: ${DB_PASSWORD:?set in vanflow.env}
      POSTGRES_DB: cashvan
    volumes:
      - cashvan_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cashvan -d cashvan"]
      interval: 5s
      timeout: 3s
      retries: 12

  api:
    image: cashvan-api:prod
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      NODE_ENV: production
      DB_HOST: db
      DB_PORT: 5432
      DB_USERNAME: cashvan
      DB_PASSWORD: ${DB_PASSWORD}
      DB_NAME: cashvan
      JWT_SECRET: ${JWT_SECRET:?set in vanflow.env}
      CORS_ORIGINS: ${CORS_ORIGINS}
    command: ["npm", "run", "start:deploy"]   # migrate → seed → start
    ports:
      - "3000:3000"
    volumes:
      - cashvan_storage:/app/storage

  dashboard:
    image: vanflow-dashboard:latest
    restart: unless-stopped
    depends_on:
      - api
    environment:
      NODE_ENV: production
    ports:
      - "8080:3000"

volumes:
  cashvan_pgdata:
  cashvan_storage:
```

`docker-compose.erp.yml` — **ERP = Web + DB + one-shot migrator**:
```yaml
name: erp
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${ERP_DB_PASSWORD:?set in erp.env}
      POSTGRES_DB: erp_database
    volumes:
      - erp_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d erp_database"]
      interval: 5s
      timeout: 5s
      retries: 12

  migrate:
    image: erp-migrator:latest
    command: npm run db:migrate
    restart: "no"
    environment:
      DATABASE_URL: postgresql://postgres:${ERP_DB_PASSWORD}@db:5432/erp_database
    depends_on:
      db:
        condition: service_healthy

  app:
    image: erp:latest
    restart: unless-stopped
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://postgres:${ERP_DB_PASSWORD}@db:5432/erp_database
      SESSION_SECRET: ${SESSION_SECRET:?set in erp.env}
      NEXT_PUBLIC_APP_URL: ${ERP_APP_URL}
    ports:
      - "3001:3000"
    depends_on:
      db:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully

volumes:
  erp_pgdata:
```

---

## 8. Start it

```bash
docker compose --env-file vanflow.env -f docker-compose.vanflow.yml up -d
docker compose --env-file erp.env     -f docker-compose.erp.yml     up -d
```

- The **API** runs migrations + seed automatically on first boot (`start:deploy`).
- The **ERP** `migrate` container runs Drizzle migrations, exits, then the app starts.

Watch progress:
```bash
docker compose -f docker-compose.vanflow.yml logs -f api
docker compose -f docker-compose.erp.yml     logs -f migrate app
```

---

## 9. Verify

```bash
curl http://<SERVER-IP>:3000/api/v1/health      # API up (or open in a browser)
```
- Dashboard: open `http://<SERVER-IP>:8080` — log in with the seeded admin (`admin` / `admin1234`) and **change the password immediately**.
- ERP: open `http://<SERVER-IP>:3001`.

On the **client PCs / phones on the LAN**, the FlowVan app and the dashboard both point
at `http://<SERVER-IP>:3000`. Open the Windows Firewall for ports **3000, 8080, 3001**
(and 3007 if using the hub).

---

## 10. Operate

**Logs / status**
```bash
docker compose -f docker-compose.vanflow.yml ps
docker compose -f docker-compose.vanflow.yml logs -f
```

**Restart / stop**
```bash
docker compose -f docker-compose.vanflow.yml restart api
docker compose -f docker-compose.vanflow.yml down          # stop (keeps data volumes)
```

**Back up the databases** (data lives in the named volumes — back these up):
```bash
docker exec vanflow-db-1 pg_dump -U cashvan cashvan | gzip > cashvan-$(date +%F).sql.gz
docker exec erp-db-1     pg_dump -U postgres erp_database | gzip > erp-$(date +%F).sql.gz
```

**Update to a new version** (repeat the whole flow):
1. On your machine: rebuild the changed image(s) (§2), `docker save` (§3), copy over (§4).
2. On the server: `docker load` (§5), then
   `docker compose -f docker-compose.vanflow.yml up -d` — Compose recreates only the
   changed containers; volumes (data) are preserved.

---

## Optional — Integration Hub

If you deploy the Hub on the same server, add a third stack using
`integration-hub:latest` + its own `postgres:16-alpine` (`integration_hub` DB), publish
port **3007**, and set `INTEGRATION_ENCRYPTION_KEY`, `ADMIN_API_TOKEN`, and
`DATABASE_URL` (see `ERP/integration-hub/docker-compose.yml`). Then point the ERP's
`INTEGRATION_HUB_URL` and FlowVan's hub settings at `http://<SERVER-IP>:3007`. The Hub
runs its own Drizzle migration on boot.

---

## Alternative — private registry (instead of tarballs)

If the client server **does** have internet, skip §3–§5 and push/pull instead:

```bash
# your machine
docker tag cashvan-api:prod  registry.example.com/vanflow/cashvan-api:1.0
docker push registry.example.com/vanflow/cashvan-api:1.0
# client server
docker login registry.example.com && docker pull registry.example.com/vanflow/cashvan-api:1.0
```
Use the registry image name in the compose `image:` fields.
