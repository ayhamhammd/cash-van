import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-tenancy: `tenant_id` on every table + Postgres row-level security.
 *
 * WHY RLS INSTEAD OF `WHERE tenant_id = …` IN EVERY QUERY
 * This codebase has ~500 raw SQL calls across ~67 files. Filtering by hand means
 * one forgotten predicate silently serves another company's data. RLS moves the
 * check into the database, so raw SQL, query builders and repositories are all
 * covered by the same rule, and a missed code path returns ZERO rows instead of
 * someone else's.
 *
 * The policies read `current_setting('app.tenant_id', true)`. When that GUC is
 * unset the expression is NULL, every comparison is NULL, and nothing matches —
 * the system FAILS CLOSED. An un-migrated code path is visibly broken in dev
 * rather than quietly leaking in production.
 *
 * This migration introspects the schema rather than listing tables, so it cannot
 * fall out of date with the 72 tables that exist today, and it applies the same
 * treatment to anything added before it runs.
 *
 * Existing data is preserved: every current row is assigned to one default
 * tenant, which is exactly what a single-company install already is.
 */

/**
 * Fixed id so re-running, seeding and the tests all agree on which tenant owns
 * the pre-existing rows. Overridable for installs that want their own id.
 */
const DEFAULT_TENANT_ID =
  process.env.DEFAULT_TENANT_ID ?? '00000000-0000-0000-0000-000000000001';
const DEFAULT_TENANT_CODE = process.env.DEFAULT_TENANT_CODE ?? 'DEFAULT';

/** Never gets a tenant_id: bookkeeping tables and the tenant registry itself. */
const EXCLUDED_TABLES = new Set([
  'tenants',
  'migrations',
  'typeorm_metadata',
]);

/**
 * Unique constraints that must stay GLOBAL rather than becoming per-tenant.
 * `quote_templates.public_token` addresses a public URL — if two tenants could
 * mint the same token, one customer's quote link would open another's quote.
 */
const KEEP_GLOBALLY_UNIQUE = new Set(['uq_quote_templates_token']);

/**
 * Tables whose PRIMARY KEY has to become per-tenant.
 *
 * A key made of uuids, or of a sequence-backed id, is already unique across the
 * whole database — widening it would add an index column for nothing. A key
 * made of VALUES is the problem:
 *
 *   transaction_kinds  PRIMARY KEY (trans_kind)               — 'SALE', 'RETURN', …
 *   erp_sync_cursor    PRIMARY KEY (entity)                   — 'items', 'customers', …
 *   voucher_counters   PRIMARY KEY (store_number, trans_kind) — the numbering cursor
 *   app_settings       PRIMARY KEY (id) where id is ALWAYS 1  — the single-row settings table
 *
 * Without this the second company cannot have a SALE transaction kind, an items
 * sync cursor, its own voucher counter, or — worst of the four — its own company
 * name, tax mode and ERP credentials. Each insert collides with the first
 * company's row.
 *
 * `app_settings` is the one that looks safe and is not: its key is called `id`
 * like everything else, but it is a smallint pinned to 1 rather than a uuid.
 * The assertion below is what actually keeps this list honest.
 */
const NATURAL_KEY_PK_TABLES = [
  'transaction_kinds',
  'erp_sync_cursor',
  'voucher_counters',
  'app_settings',
];

interface UniqueIndexRow {
  table_name: string;
  index_name: string;
  index_oid: string;
  constraint_name: string | null;
  /** 'p' primary key, 'u' unique constraint, null for a bare unique index. */
  constraint_type: string | null;
  predicate: string | null;
  columns: string[] | null;
}

interface DependentFkRow {
  fk_name: string;
  child_table: string;
  child_columns: string[];
  parent_columns: string[];
  on_delete: string;
  on_update: string;
}

/** pg_constraint stores FK actions as single chars. */
const FK_ACTION: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

const quote = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
const quoteList = (idents: string[]): string => idents.map(quote).join(', ');

export class TenancyAndRls1723700000000 implements MigrationInterface {
  name = 'TenancyAndRls1723700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. The tenant registry ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenants" (
        "id"            uuid NOT NULL DEFAULT uuid_generate_v4(),
        "code"          text NOT NULL,
        "name"          text NOT NULL,
        "status"        text NOT NULL DEFAULT 'active',
        "crm_tenant_id" uuid,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tenants" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tenants_code" ON "tenants" ("code")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tenants_crm_id" ON "tenants" ("crm_tenant_id")
       WHERE "crm_tenant_id" IS NOT NULL`,
    );

    // Name the default tenant after the company already configured on this box,
    // so an upgraded single-tenant install reads sensibly in the CRM later.
    const existingName = await queryRunner.query(`
      SELECT "company_name_ar" AS name FROM "app_settings" LIMIT 1
    `).catch(() => [] as { name: string }[]);
    const defaultName =
      (existingName as { name?: string }[])[0]?.name ?? 'Default Company';

    await queryRunner.query(
      `INSERT INTO "tenants" ("id", "code", "name")
       VALUES ($1, $2, $3)
       ON CONFLICT ("id") DO NOTHING`,
      [DEFAULT_TENANT_ID, DEFAULT_TENANT_CODE, defaultName],
    );

    // ── 1b. Per-tenant document numbering ────────────────────────────────────
    // Invoice/customer/vendor/credit-note numbers came from GLOBAL sequences,
    // so tenant B's first invoice would continue tenant A's numbering — and an
    // accountant would see gaps they cannot explain. A counter row per tenant
    // replaces them.
    //
    // Declared with tenant_id already in the primary key; the generic loops
    // below then add the default, index and foreign key like any other table.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenant_counters" (
        "tenant_id" uuid NOT NULL,
        "name"      text NOT NULL,
        "value"     bigint NOT NULL DEFAULT 0,
        CONSTRAINT "pk_tenant_counters" PRIMARY KEY ("tenant_id", "name")
      )
    `);

    // Seed the default tenant from where its sequences currently stand, so
    // numbering continues rather than restarting on top of existing documents.
    // pg_sequence_last_value is NULL for a sequence that has never been used.
    for (const [name, sequence] of [
      ['invoice', 'invoice_number_seq'],
      ['credit_note', 'credit_note_number_seq'],
      ['customer', 'customer_number_seq'],
      ['vendor', 'vendor_number_seq'],
    ]) {
      await queryRunner.query(
        `
        INSERT INTO "tenant_counters" ("tenant_id", "name", "value")
        SELECT $1, $2, coalesce(pg_sequence_last_value(to_regclass($3::text)), 0)
        WHERE to_regclass($3::text) IS NOT NULL
        ON CONFLICT ("tenant_id", "name") DO NOTHING
        `,
        [DEFAULT_TENANT_ID, name, sequence],
      );
    }

    // ── 2. Which tables get a tenant_id ──────────────────────────────────────
    // Partitions are excluded here: ALTER TABLE on a partitioned parent
    // propagates the column to every partition automatically, and altering a
    // partition directly is rejected by Postgres.
    const scoped: { table_name: string }[] = await queryRunner.query(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
      ORDER BY c.relname
    `);

    const tables = scoped
      .map((r) => r.table_name)
      .filter((t) => !EXCLUDED_TABLES.has(t));

    // ── 3. Add + backfill tenant_id ──────────────────────────────────────────
    for (const table of tables) {
      await queryRunner.query(
        `ALTER TABLE ${quote(table)} ADD COLUMN IF NOT EXISTS "tenant_id" uuid`,
      );
      await queryRunner.query(
        `UPDATE ${quote(table)} SET "tenant_id" = $1 WHERE "tenant_id" IS NULL`,
        [DEFAULT_TENANT_ID],
      );
      await queryRunner.query(
        `ALTER TABLE ${quote(table)} ALTER COLUMN "tenant_id" SET NOT NULL`,
      );
      // Inserts that omit tenant_id get the caller's tenant automatically, so
      // ~1000 existing INSERT sites keep working untouched. nullif for the same
      // reason as the policy below: a cleared GUC reads back as '' and ''::uuid
      // raises rather than returning NULL.
      await queryRunner.query(
        `ALTER TABLE ${quote(table)} ALTER COLUMN "tenant_id" SET DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid`,
      );
      // Every tenant-scoped read starts with this predicate, so it leads the index.
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS ${quote(`idx_${table}_tenant`)} ON ${quote(table)} ("tenant_id")`,
      );
    }

    // The FK is added after the loop so ordering between tables cannot matter.
    // Partitioned parents accept it from Postgres 12 onward.
    for (const table of tables) {
      await queryRunner.query(`
        ALTER TABLE ${quote(table)}
        ADD CONSTRAINT ${quote(`fk_${table}_tenant`)}
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
      `);
    }

    // ── 4. Global uniques become per-tenant ──────────────────────────────────
    // `uq_users_user_number` is the clearest case: two companies must both be
    // allowed a user called "admin". Same for customer numbers, invoice numbers
    // and barcodes.
    // Guard the list above. A primary key is safe to leave alone when it
    // already contains tenant_id, or when AT LEAST ONE of its columns is
    // unique database-wide — a uuid, or a sequence-backed integer. One such
    // column makes the whole composite key unique, which is why
    // `(id, acted_at)` on the partitioned tables needs nothing: `id` carries
    // the uniqueness and `acted_at` is only there because Postgres requires
    // the partition key in the primary key.
    //
    // A table is a problem only when EVERY column of its key is a value.
    //
    // Derived from the catalogue rather than trusted, because the failure mode
    // is silent: the migration succeeds, and the collision only appears the day
    // someone onboards the second company.
    const naturalKeys: { table_name: string }[] = await queryRunner.query(
      `
      SELECT t.relname AS table_name
      FROM pg_constraint con
      JOIN pg_class t     ON t.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE con.contype = 'p'
        AND n.nspname = 'public'
        AND t.relname = ANY($1)
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(con.conkey) AS k(attnum)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
          LEFT JOIN pg_attrdef d ON d.adrelid = t.oid AND d.adnum = a.attnum
          WHERE a.attname = 'tenant_id'
             OR a.atttypid = 'uuid'::regtype
             OR coalesce(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval%'
        )
      ORDER BY t.relname
      `,
      [tables],
    );

    const unhandled = naturalKeys
      .map((r) => r.table_name)
      .filter((t) => !NATURAL_KEY_PK_TABLES.includes(t));
    if (unhandled.length > 0) {
      throw new Error(
        `These tables have a primary key built from values rather than ids, so ` +
          `only one tenant could ever hold a row: ${unhandled.join(', ')}. ` +
          `Add them to NATURAL_KEY_PK_TABLES in this migration.`,
      );
    }

    const uniques: UniqueIndexRow[] = await queryRunner.query(
      `
      SELECT
        t.relname   AS table_name,
        i.relname   AS index_name,
        i.oid::text AS index_oid,
        con.conname AS constraint_name,
        con.contype::text AS constraint_type,
        pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
        -- ::text[] matters: attname has the pg "name" type, and the driver
        -- hands back an unparsed string for name[] rather than a JS array.
        (
          SELECT array_agg(a.attname::text ORDER BY k.ord)::text[]
          FROM unnest(ix.indkey::int[]) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a
            ON a.attrelid = t.oid AND a.attnum = k.attnum
        ) AS columns
      FROM pg_index ix
      JOIN pg_class i      ON i.oid = ix.indexrelid
      JOIN pg_class t      ON t.oid = ix.indrelid
      JOIN pg_namespace n  ON n.oid = t.relnamespace
      LEFT JOIN pg_constraint con
        ON con.conindid = i.oid AND con.contype IN ('u', 'p')
      WHERE n.nspname = 'public'
        AND ix.indisunique
        -- Primary keys are left alone except on the natural-key tables, whose
        -- keys are values like 'SALE' that every tenant needs its own copy of.
        AND (NOT ix.indisprimary OR t.relname = ANY($2))
        AND t.relname = ANY($1)
      ORDER BY t.relname, i.relname
      `,
      [tables, NATURAL_KEY_PK_TABLES],
    );

    for (const u of uniques) {
      if (KEEP_GLOBALLY_UNIQUE.has(u.index_name)) continue;
      if (u.index_name === 'uq_tenants_code') continue;
      // Expression indexes report a null attname; leave them for a human.
      if (!u.columns || u.columns.some((c) => c == null)) continue;
      if (u.columns.includes('tenant_id')) continue;

      // A unique constraint can be the target of foreign keys. Dropping it
      // would take those FKs with it, so they are rebuilt as COMPOSITE keys
      // including tenant_id — which also makes a cross-tenant reference
      // impossible at the database level, not merely unlikely.
      const dependents: DependentFkRow[] = await queryRunner.query(
        `
        SELECT
          con.conname   AS fk_name,
          ch.relname    AS child_table,
          (
            SELECT array_agg(a.attname::text ORDER BY k.ord)::text[]
            FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = ch.oid AND a.attnum = k.attnum
          ) AS child_columns,
          (
            SELECT array_agg(a.attname::text ORDER BY k.ord)::text[]
            FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
          ) AS parent_columns,
          con.confdeltype AS on_delete,
          con.confupdtype AS on_update
        FROM pg_constraint con
        JOIN pg_class ch ON ch.oid = con.conrelid
        WHERE con.contype = 'f' AND con.conindid = $1::oid
        `,
        [u.index_oid],
      );

      for (const fk of dependents) {
        await queryRunner.query(
          `ALTER TABLE ${quote(fk.child_table)} DROP CONSTRAINT ${quote(fk.fk_name)}`,
        );
      }

      if (u.constraint_name) {
        await queryRunner.query(
          `ALTER TABLE ${quote(u.table_name)} DROP CONSTRAINT ${quote(u.constraint_name)}`,
        );
      } else {
        await queryRunner.query(`DROP INDEX ${quote(u.index_name)}`);
      }

      const cols = ['tenant_id', ...u.columns];
      if (u.constraint_type === 'p') {
        await queryRunner.query(
          `ALTER TABLE ${quote(u.table_name)} ADD CONSTRAINT ${quote(u.constraint_name as string)} PRIMARY KEY (${quoteList(cols)})`,
        );
      } else if (u.predicate) {
        // Partial uniques cannot be constraints, and cannot be FK targets
        // either — so no dependent keys to rebuild.
        await queryRunner.query(
          `CREATE UNIQUE INDEX ${quote(u.index_name)} ON ${quote(u.table_name)} (${quoteList(cols)}) WHERE ${u.predicate}`,
        );
      } else if (dependents.length > 0 || u.constraint_name) {
        // A real constraint, so foreign keys can point at it.
        await queryRunner.query(
          `ALTER TABLE ${quote(u.table_name)} ADD CONSTRAINT ${quote(u.index_name)} UNIQUE (${quoteList(cols)})`,
        );
      } else {
        await queryRunner.query(
          `CREATE UNIQUE INDEX ${quote(u.index_name)} ON ${quote(u.table_name)} (${quoteList(cols)})`,
        );
      }

      for (const fk of dependents) {
        await queryRunner.query(`
          ALTER TABLE ${quote(fk.child_table)}
          ADD CONSTRAINT ${quote(fk.fk_name)}
          FOREIGN KEY ("tenant_id", ${quoteList(fk.child_columns)})
          REFERENCES ${quote(u.table_name)} ("tenant_id", ${quoteList(fk.parent_columns)})
          ON DELETE ${FK_ACTION[fk.on_delete] ?? 'NO ACTION'}
          ON UPDATE ${FK_ACTION[fk.on_update] ?? 'NO ACTION'}
        `);
      }
    }

    // ── 5. Row-level security ────────────────────────────────────────────────
    // Enabled on partitions too. A policy on the parent covers reads that go
    // through the parent, but a query naming a partition directly is checked
    // against that partition's own policies — so both need it.
    const rlsTargets: { table_name: string }[] = await queryRunner.query(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
      ORDER BY c.relname
    `);

    for (const { table_name: table } of rlsTargets) {
      if (EXCLUDED_TABLES.has(table)) continue;
      await queryRunner.query(
        `ALTER TABLE ${quote(table)} ENABLE ROW LEVEL SECURITY`,
      );
      // FORCE matters: without it the table owner bypasses every policy, and
      // the application currently connects as the owner.
      await queryRunner.query(
        `ALTER TABLE ${quote(table)} FORCE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `DROP POLICY IF EXISTS "tenant_isolation" ON ${quote(table)}`,
      );
      // nullif(…, '') is load-bearing. Once a custom GUC has been set on a
      // connection, clearing it leaves an EMPTY STRING rather than unsetting
      // it — and ''::uuid raises "invalid input syntax" instead of yielding
      // NULL. Without nullif, the first unscoped query on a pooled connection
      // that has previously served a tenant blows up rather than returning
      // nothing. Both fail closed; only one of them is debuggable.
      await queryRunner.query(`
        CREATE POLICY "tenant_isolation" ON ${quote(table)}
        USING      ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
      `);
    }

    // ── 6. The role the application connects as ──────────────────────────────
    // WITHOUT THIS THE WHOLE MIGRATION IS DECORATIVE. A Postgres superuser
    // ignores row-level security entirely — FORCE included — and the default
    // container user (POSTGRES_USER=cashvan) is a superuser that also owns
    // every table. So the API must connect as a separate, unprivileged role.
    //
    // Migrations keep running as the owner; only the running app switches.
    // See DB_APP_USERNAME / DB_APP_PASSWORD in config/validation.schema.ts.
    const appRole = process.env.DB_APP_USERNAME ?? 'cashvan_app';
    const appPassword = process.env.DB_APP_PASSWORD ?? '';

    const [{ exists }]: { exists: boolean }[] = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`,
      [appRole],
    );

    if (!exists) {
      // No password configured yet: create the role without login so the grants
      // below are in place, and a single ALTER ROLE turns it on later. Better
      // than inventing a default password that would inevitably reach prod.
      await queryRunner.query(
        appPassword
          ? `CREATE ROLE ${quote(appRole)} LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}'`
          : `CREATE ROLE ${quote(appRole)} NOLOGIN`,
      );
    } else if (appPassword) {
      await queryRunner.query(
        `ALTER ROLE ${quote(appRole)} LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}'`,
      );
    }

    // Belt and braces: a role created by hand elsewhere might carry these.
    await queryRunner.query(
      `ALTER ROLE ${quote(appRole)} NOSUPERUSER NOBYPASSRLS`,
    );

    // CREATE as well as USAGE: the app creates next month's audit_log and
    // rep_location_events partitions on a cron, and that is DDL. Without it
    // the partition job fails and inserts start rejecting once the current
    // month's range runs out.
    await queryRunner.query(
      `GRANT USAGE, CREATE ON SCHEMA public TO ${quote(appRole)}`,
    );
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quote(appRole)}`,
    );
    await queryRunner.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quote(appRole)}`,
    );
    // Tables created by future migrations must be reachable without revisiting
    // this migration.
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quote(appRole)}
    `);
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO ${quote(appRole)}
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const all: { table_name: string }[] = await queryRunner.query(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
      ORDER BY c.relname
    `);

    for (const { table_name: table } of all) {
      if (EXCLUDED_TABLES.has(table)) continue;
      await queryRunner.query(
        `DROP POLICY IF EXISTS "tenant_isolation" ON ${quote(table)}`,
      );
      await queryRunner.query(
        `ALTER TABLE ${quote(table)} NO FORCE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `ALTER TABLE ${quote(table)} DISABLE ROW LEVEL SECURITY`,
      );
    }

    // Composite uniques and the FKs rebuilt on top of them are left in place:
    // dropping tenant_id CASCADEs them away, and rebuilding the single-column
    // originals from here would silently fail on data that has since become
    // ambiguous across tenants. A downgrade is only safe on a single-tenant
    // database, where the composite form is equivalent anyway.
    const scoped: { table_name: string }[] = await queryRunner.query(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
      ORDER BY c.relname
    `);

    for (const { table_name: table } of scoped) {
      if (EXCLUDED_TABLES.has(table)) continue;
      await queryRunner.query(
        `ALTER TABLE ${quote(table)} DROP COLUMN IF EXISTS "tenant_id" CASCADE`,
      );
    }

    await queryRunner.query(`DROP TABLE IF EXISTS "tenants"`);
  }
}
