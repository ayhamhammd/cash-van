# SPEC — Backup configuration in App Settings

Give each installation a backup it does not have to remember: **when** to take one, **where**
to put it, how long to keep it, and proof that the last one is restorable — configured from
Settings, visible on the dashboard, with a manual "Export backup now" that produces the same
artifact.

Scope: `app_settings` (new backup section), a new `backups` module, the Settings screen.
Relevant because every client runs its own database on its own box
(`docs/DEPLOY-client-docker-images.md`, `DEPLOY-ONPREM.md`) with nobody holding a DBA role.

---

## 1. What exists today (verified 2026-09-21)

Nothing, beyond a documented command. `docs/DEPLOY-client-docker-images.md:313`:

    docker exec vanflow-db-1 pg_dump -U cashvan cashvan | gzip > cashvan-$(date +%F).sql.gz
    docker exec erp-db-1     pg_dump -U postgres erp_database | gzip > erp-$(date +%F).sql.gz

So the current backup strategy is: a human with shell access on the client's server remembers
to run two commands, decides where the file goes, and never checks whether it restores. There
is no schedule, no retention, no UI, no record of the last successful backup, and no alarm when
backups stop. `scripts/` has build and import tooling but no backup script.

There is one piece to build on: `configuration.ts:29` already defines a storage root
(`STORAGE_LOCAL_ROOT`, default `./storage`) that is a mounted path in every deployment, so
"a directory the container can write that outlives the container" is already an established
idea here.

### 1.1 The trap that makes this more than a convenience

`SettingsService.getErpConfig()` **throws when the stored ERP API key cannot be decrypted**,
and the reason is recorded in the code (`erp-outbox.service.ts:135`):

> the stored API key can't be decrypted — which is what happens if `JWT_SECRET` or the KMS key
> changes between deploys

The API key is stored encrypted **with a secret that lives outside the database**. A dump
restored onto a host with a different `JWT_SECRET` produces a database that looks complete and
whose ERP connection is silently dead — every voucher piles up in the outbox. A backup that does
not capture this is a backup that fails at the moment it is needed.

So a backup artifact here is not just a `pg_dump`. §4.2 defines what else goes in it.

---

## 2. What the owner configures

One section in Settings → **النسخ الاحتياطي / Backup**, and these are the questions it answers:

| setting | values | default |
|---|---|---|
| Enabled | on / off | **off** — it must be a deliberate choice, with a destination |
| Schedule | daily at `HH:MM`, or a cron expression | `02:30`, company timezone |
| What to include | VanFlow database, ERP database, uploaded files (`storage/`) | VanFlow + secrets manifest |
| Destination | **Local directory** / **Network share** / **S3-compatible** | local directory |
| Local path | absolute path inside the container, which must be a mounted volume | `/backups` |
| Retention | keep N daily, M weekly, K monthly | 14 / 8 / 6 |
| Encrypt | off / passphrase | off |
| Verify after write | on / off | **on** |
| Notify on failure | the existing notification rules | on |

**Destination, spelled out**, because "where do I save it" is the question that actually gets
people into trouble:

- **Local directory** — a path the API container can write, which **must be a bind mount or a
  named volume**, not a path that exists only inside the container's own filesystem. A backup
  written to the container's layer disappears on the next `docker compose up -d`, which is
  exactly when you want it. §4.5 refuses to accept a path that is not a mount point.
- **Network share** — an SMB/NFS share mounted on the host and bind-mounted into the container.
  From the application's side this is indistinguishable from a local directory, which is the
  point: the mount is the sysadmin's job and the app does not need credentials for it. The UI
  says so, and the `docker-compose` snippet to add the mount is shown inline next to the field.
- **S3-compatible** — endpoint, region, bucket, prefix, access key, secret. For clients with
  offsite storage or a MinIO box. The secret is stored encrypted, the same way the ERP key is,
  and is subject to the same caveat as §1.1 — which is why the secrets manifest records its
  fingerprint.

A destination that is *only* the same physical disk as the database is not a backup. The UI
states this once, plainly, and a local-directory destination that resolves to the same
filesystem as the Postgres volume is shown with a warning badge — not blocked, because for some
clients it is genuinely all there is, but never silently presented as safe.

---

## 3. Schema

`src/database/migrations/1727400000000-BackupConfiguration.ts`

    ALTER TABLE app_settings
      ADD COLUMN backup_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN backup_cron           TEXT    NOT NULL DEFAULT '30 2 * * *',
      ADD COLUMN backup_include        JSONB   NOT NULL
        DEFAULT '{"vanflowDb":true,"erpDb":false,"files":false,"secretsManifest":true}',
      ADD COLUMN backup_destination    TEXT    NOT NULL DEFAULT 'local',   -- local | s3
      ADD COLUMN backup_local_path     TEXT    NOT NULL DEFAULT '/backups',
      ADD COLUMN backup_s3             JSONB,                -- endpoint/region/bucket/prefix/accessKeyId
      -- Named to match the existing convention in this table
      -- (erp_api_key_encrypted, ai_api_key_encrypted, …), and `select: false`
      -- on the entity so it is never returned by an ordinary settings read.
      ADD COLUMN backup_s3_secret_encrypted  TEXT,
      ADD COLUMN backup_passphrase_encrypted TEXT,
      ADD COLUMN backup_retention      JSONB   NOT NULL
        DEFAULT '{"daily":14,"weekly":8,"monthly":6}',
      ADD COLUMN backup_verify         BOOLEAN NOT NULL DEFAULT TRUE;

    CREATE TABLE backup_runs (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trigger       TEXT        NOT NULL,          -- 'schedule' | 'manual'
      started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at   TIMESTAMPTZ,
      status        TEXT        NOT NULL DEFAULT 'running',
                                                   -- running|success|failed|verify_failed
      destination   TEXT        NOT NULL,
      artifact_path TEXT,                          -- full path or s3://bucket/key
      size_bytes    BIGINT,
      sha256        TEXT,
      -- What was proved about it, not what was hoped: object counts read back out
      -- of the artifact by the verify step.
      verified_at   TIMESTAMPTZ,
      verify_detail JSONB,
      row_counts    JSONB,                         -- sanity anchors: vouchers, customers, items
      error         TEXT,
      created_by    UUID                           -- NULL for scheduled runs
    );
    CREATE INDEX idx_backup_runs_started ON backup_runs (started_at DESC);

`backup_runs` is the deliverable that makes the feature trustworthy. "The last backup succeeded
at 02:31 today, 412 MB, verified, 1,284,003 voucher lines" is an answer. "There is a cron job
somewhere" is not.

---

## 4. Backend

New module `src/modules/backups/`: `backups.module.ts`, `backups.service.ts`,
`backups.controller.ts`, `backup-destination.ts` (local + S3 writers behind one interface).

### 4.1 Routes

| route | role | notes |
|---|---|---|
| `GET /api/v1/backups/config` | admin | never returns the S3 secret or passphrase, only whether one is set |
| `PUT /api/v1/backups/config` | admin | validates the destination before saving (§4.5) |
| `POST /api/v1/backups/test-destination` | admin | writes and deletes a 1 KB probe file; returns the resolved mount and free space |
| `POST /api/v1/backups/run` | admin | "Export backup now"; returns a `backup_runs` id, runs in the background |
| `GET /api/v1/backups/runs` | admin | history, newest first |
| `GET /api/v1/backups/runs/:id/download` | admin | streams a **local** artifact; `410` once retention has removed it |

`@SkipAudit()` is **not** applied: every config change and every manual run belongs in
`audit_log`.

The download route streams from `backup_local_path` and must resolve the requested path against
the configured root and refuse anything outside it. Do not serve backups through
`STORAGE_PUBLIC_BASE_URL` — that path is public by design and a database dump is the single
most sensitive file on the box.

### 4.2 What the artifact contains

A single `.tar.gz`, `vanflow-backup-<company>-<YYYYMMDD-HHmm>.tar.gz`:

    manifest.json           schema version, app version + git sha, taken_at, company_number,
                            timezone, included parts, row_counts, sha256 of each member
    vanflow.dump            pg_dump --format=custom --compress=0   (custom format: selective
                            restore, and pg_restore --list works as a verification read)
    erp.dump                optional
    files.tar               optional: STORAGE_LOCAL_ROOT
    secrets-manifest.json   see below

`secrets-manifest.json` is the answer to §1.1. It contains **no secret values** — only what is
needed to detect a mismatch on restore:

    { "jwtSecretFingerprint": "sha256:…first 12 hex…",
      "erpApiKeySet": true,
      "erpBaseUrl": "https://…",
      "encryptedColumns": ["app_settings.erp_api_key_encrypted",
                           "app_settings.ai_api_key_encrypted",
                           "app_settings.google_maps_api_key_encrypted",
                           "app_settings.jofotara_secret_key_encrypted",
                           "app_settings.backup_s3_secret_encrypted"],
      "note": "Restoring onto a host with a different JWT_SECRET leaves every value in
               encryptedColumns unreadable. Re-enter them in Settings after restore." }

The fingerprint is a salted hash, never the secret. On restore, §4.6's check compares the
running host's fingerprint against it and says plainly which fields must be re-entered.

`pg_dump` runs against `DATABASE_URL` with `--no-owner --no-privileges`, so the dump restores
into a differently-named role — which is what happens on every real recovery.

**`pg_dump` must be present in the API image.** It is not today. Add the `postgresql-client`
package matching the server's major version to the runtime stage of `Dockerfile`, and have
`test-destination` report the detected `pg_dump` version alongside the server version. A major
mismatch is refused: `pg_dump` older than the server cannot dump it, and that failure at 02:30
with nobody watching is precisely the scenario this feature exists to prevent.

### 4.3 The schedule

    @Cron(<from app_settings.backup_cron>, { timeZone: <app_settings.timezone> })

`@Cron` needs its expression at class-definition time, and this one lives in the database. Use
`SchedulerRegistry` to register and re-register the job when the config is saved, and log the
next fire time on boot and after every change so "is it actually scheduled?" is answerable from
the log.

Wrap the run in a Postgres advisory lock (`pg_advisory_lock(hashtext('backup'))`) so two API
instances, or a manual run overlapping the schedule, cannot produce two dumps at once.

Every run writes its `backup_runs` row **first**, with `status='running'`. A row still
`running` on boot is marked `failed` with "interrupted by a restart" — a crashed backup that
looks like a running one is the same lie as a stalled sync that looks like a live one.

### 4.4 Verify, or it did not happen

With `backup_verify` on, after the artifact is written:

1. re-read it from the destination (not from a local temp copy — the point is to prove the
   destination holds it),
2. check `sha256` against the manifest,
3. `pg_restore --list vanflow.dump` and assert the expected tables appear,
4. compare `manifest.row_counts` for `voucher_headers`, `customers`, `item_cart` against the
   live database, allowing for growth during the dump,
5. write `verified_at` + `verify_detail`.

A failed verify is `verify_failed`, **not** `success`, and notifies. An unverified backup is
inventory, not insurance.

### 4.5 Destination validation, on save

`PUT /backups/config` refuses to save a destination it cannot use:

- the local path exists, or can be created, and is writable — probe-write and delete;
- it is **a mount point or inside one** — compare the path's device id with `/`'s via `statfs`;
  if they match, the path is on the container's own filesystem. Refuse, and say why: *"هذا
  المسار داخل الحاوية وسيُفقد عند إعادة النشر. أضف volume في docker-compose."* with the exact
  snippet to add;
- at least 3× the current database size is free, reported back so the number is visible;
- if the path's filesystem is the same device as the Postgres data volume, save it but return a
  warning the UI renders as a badge;
- S3: a real round-trip — put, get, delete a probe object under the configured prefix.

### 4.6 Restore is a documented procedure, not a button

Restoring is destructive and touches containers, so it stays a runbook — but the application
provides the two things a runbook cannot: `GET /api/v1/backups/runs/:id/restore-plan` returns
the exact `pg_restore` invocation for that artifact, and the secrets-manifest comparison
against the current host (§4.2), naming every field that will need re-entering.

A new `docs/RUNBOOK-restore-from-backup.md` holds the procedure: stop the API, restore into a
**new** database, point `DATABASE_URL` at it, run `migration:run`, compare row counts, start,
re-enter any secret the manifest flagged, and confirm the ERP outbox drains. Written so the
person following it at 3am has never seen this codebase.

---

## 5. Dashboard

Settings → Backup:

- the fields from §2, with the destination picker driving which sub-fields show;
- **Test destination** beside the path field, reporting resolved mount, free space, whether it
  is a mount point, and the detected `pg_dump`/server versions;
- **Export backup now**, with live progress from the `backup_runs` row;
- a history table: taken at, trigger, size, destination, verified, download;
- a status strip at the top — green with the last verified backup's age, amber past 48h, red
  when disabled or when the last run failed. The same strip appears on the dashboard home for
  admins, because a backup page nobody opens is the state we are in today.

Retention is shown as what it resolves to ("14 daily, 8 weekly, 6 monthly → about 28 files,
roughly 11 GB at the current size"), not as three numbers the owner has to model in their head.

---

## 6. Acceptance

1. **Manual export.** Configure a local mounted path, run "Export backup now". Artifact exists
   on the host, `backup_runs` says `success` with `verified_at` set and matching `sha256`.
2. **Restore works.** Restore the artifact into an empty database on another host, run
   migrations, log in, and confirm voucher and customer counts match the manifest.
3. **Secret mismatch is announced.** Restore onto a host with a different `JWT_SECRET`. The
   restore plan names `erp_api_key_enc` and the others; the ERP status page reports the
   undecryptable key rather than silently stalling.
4. **Non-mounted path is refused.** Point the destination at `/tmp/x` in the container. Save is
   refused with the compose snippet in the message.
5. **Schedule fires.** Set the cron two minutes out. One run, one row, one artifact — even with
   two API instances running.
6. **Retention prunes.** Seed 30 daily artifacts; after a run, exactly the configured set
   remains, and pruned rows return `410` on download.
7. **Failure is loud.** Make the destination read-only mid-run. `status='failed'`, notification
   raised, status strip red.
8. **Verify catches corruption.** Truncate the artifact after write. `verify_failed`, not
   `success`.
9. **Interrupted run is not left running.** Kill the API mid-backup; on boot the row is
   `failed` with the restart reason.

## 7. Out of scope

Point-in-time recovery (WAL archiving / `pgBackRest`) is the right answer for a client who
cannot lose an hour of sales, and it is a different piece of work — it belongs to the
deployment, not to App Settings. This spec delivers scheduled, verified, retained logical
dumps with a destination the owner chooses. If a client needs PITR, say so plainly rather than
letting a nightly dump imply a guarantee it does not give.
