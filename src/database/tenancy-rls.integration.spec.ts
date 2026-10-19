import { Client } from 'pg';

/**
 * Proves the tenancy migration actually isolates tenants, against a real
 * Postgres. Unit tests cannot cover this: the guarantee lives in the database,
 * not in TypeScript.
 *
 *   docker run -d --name cashvan-test -e POSTGRES_USER=cashvan \
 *     -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=cashvan -p 55432:5432 \
 *     postgres:16.4-alpine
 *   DB_PORT=55432 DB_PASSWORD=testpw DB_APP_PASSWORD=apppw npm run migration:run
 *   DB_PORT=55432 DB_PASSWORD=testpw DB_APP_PASSWORD=apppw npm run test:db
 *
 * Excluded from `npm test` by testPathIgnorePatterns, because it needs a
 * database. Run it with `npm run test:db`.
 */

const HOST = process.env.DB_HOST ?? 'localhost';
const PORT = parseInt(process.env.DB_PORT ?? '55432', 10);
const DATABASE = process.env.DB_NAME ?? 'cashvan';

/** Owns the tables and runs migrations. Superuser in the dev container. */
const OWNER_USER = process.env.DB_USERNAME ?? 'cashvan';
const OWNER_PASSWORD = process.env.DB_PASSWORD ?? 'testpw';

/** What the API connects as. Unprivileged, so RLS actually applies to it. */
const APP_USER = process.env.DB_APP_USERNAME ?? 'cashvan_app';
const APP_PASSWORD = process.env.DB_APP_PASSWORD ?? 'apppw';

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-0000000000b2';

/** Tables that legitimately have no tenant_id. */
const EXCLUDED = ['tenants', 'migrations', 'typeorm_metadata'];

const connect = (user: string, password: string): Client =>
  new Client({ host: HOST, port: PORT, database: DATABASE, user, password });

describe('tenancy + row-level security', () => {
  let owner: Client;
  let app: Client;

  beforeAll(async () => {
    owner = connect(OWNER_USER, OWNER_PASSWORD);
    await owner.connect();

    const { rows } = await owner.query(
      `SELECT to_regclass('public.tenants') IS NOT NULL AS ready`,
    );
    if (!rows[0].ready) {
      throw new Error(
        'Database is not migrated. Run `npm run migration:run` against it first.',
      );
    }

    await owner.query(
      `INSERT INTO tenants (id, code, name) VALUES ($1, 'TESTB', 'Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_B],
    );

    // Identical natural keys in both tenants — this only inserts at all if the
    // global uniques really did become composite.
    await owner.query(`DELETE FROM users WHERE user_number = 'rls-probe'`);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await owner.query(
        `INSERT INTO users (tenant_id, user_number, name, password_hash)
         VALUES ($1, 'rls-probe', 'RLS probe', 'x')`,
        [tenant],
      );
    }

    app = connect(APP_USER, APP_PASSWORD);
    await app.connect();
  });

  afterAll(async () => {
    await owner?.query(`DELETE FROM users WHERE user_number = 'rls-probe'`);
    await owner?.end();
    await app?.end();
  });

  // ── The test that keeps this correct as the schema grows ──────────────────
  it('every table is tenant-scoped, RLS-enabled, forced, and has a policy', async () => {
    const { rows } = await owner.query(
      `
      SELECT
        c.relname AS table_name,
        EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
            AND a.attnum > 0 AND NOT a.attisdropped
        ) AS has_tenant_id,
        c.relrowsecurity      AS rls_enabled,
        c.relforcerowsecurity AS rls_forced,
        EXISTS (
          SELECT 1 FROM pg_policy p
          WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'
        ) AS has_policy
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT (c.relname = ANY($1))
      ORDER BY c.relname
      `,
      [EXCLUDED],
    );

    expect(rows.length).toBeGreaterThan(50);

    const offenders = rows.filter(
      (r) => !r.has_tenant_id || !r.rls_enabled || !r.rls_forced || !r.has_policy,
    );
    expect(offenders.map((r) => r.table_name)).toEqual([]);
  });

  // Every primary key must be reachable by a second company. The dangerous
  // shape is a key made of VALUES rather than ids — app_settings is the one
  // that looks innocent, keyed on `id` like everything else, except that id is
  // a smallint pinned to 1 rather than a uuid. Without tenant_id in that key,
  // company B simply cannot have a company name or ERP credentials.
  it('has no primary key that only one tenant could satisfy', async () => {
    const { rows } = await owner.query(
      `
        SELECT t.relname AS table_name
        FROM pg_constraint con
        JOIN pg_class t     ON t.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE con.contype = 'p'
          AND n.nspname = 'public'
          AND NOT (t.relname = ANY($1))
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
      [EXCLUDED],
    );

    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it('lets a second tenant own its own app_settings row', async () => {
    const { rows } = await owner.query(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = 'app_settings'::regclass AND contype = 'p'`,
    );
    expect(rows[0].def).toBe('PRIMARY KEY (tenant_id, id)');
  });

  // Without this the policies above are decorative: a superuser ignores RLS.
  it('the application role cannot bypass row-level security', async () => {
    const { rows } = await owner.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
      [APP_USER],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolsuper).toBe(false);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it('fails closed: no tenant set means no rows at all', async () => {
    await app.query('BEGIN');
    const { rows } = await app.query(
      `SELECT count(*)::int AS n FROM users WHERE user_number = 'rls-probe'`,
    );
    await app.query('ROLLBACK');
    expect(rows[0].n).toBe(0);
  });

  it('shows only the current tenant rows', async () => {
    for (const tenant of [TENANT_A, TENANT_B]) {
      await app.query('BEGIN');
      await app.query(`SET LOCAL app.tenant_id = '${tenant}'`);
      const { rows } = await app.query(
        `SELECT tenant_id FROM users WHERE user_number = 'rls-probe'`,
      );
      await app.query('ROLLBACK');

      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(tenant);
    }
  });

  it('lets two tenants share a user_number that used to be globally unique', async () => {
    const { rows } = await owner.query(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = 'users'::regclass AND conname = 'uq_users_user_number'`,
    );
    expect(rows[0].def).toBe('UNIQUE (tenant_id, user_number)');

    // And the two rows seeded in beforeAll are the live proof.
    const { rows: both } = await owner.query(
      `SELECT count(*)::int AS n FROM users WHERE user_number = 'rls-probe'`,
    );
    expect(both[0].n).toBe(2);
  });

  it('rejects an insert that claims another tenant', async () => {
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.tenant_id = '${TENANT_A}'`);
    await expect(
      app.query(
        `INSERT INTO users (tenant_id, user_number, name, password_hash)
         VALUES ($1, 'rls-smuggled', 'Smuggled', 'x')`,
        [TENANT_B],
      ),
    ).rejects.toThrow(/row-level security/i);
    await app.query('ROLLBACK');
  });

  it('stamps the current tenant on an insert that omits it', async () => {
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.tenant_id = '${TENANT_A}'`);
    await app.query(
      `INSERT INTO users (user_number, name, password_hash)
       VALUES ('rls-default', 'Default stamped', 'x')`,
    );
    const { rows } = await app.query(
      `SELECT tenant_id FROM users WHERE user_number = 'rls-default'`,
    );
    await app.query('ROLLBACK');

    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('cannot update or delete another tenant rows', async () => {
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.tenant_id = '${TENANT_A}'`);

    const updated = await app.query(
      `UPDATE users SET name = 'hijacked'
       WHERE user_number = 'rls-probe' AND tenant_id = $1`,
      [TENANT_B],
    );
    expect(updated.rowCount).toBe(0);

    const deleted = await app.query(
      `DELETE FROM users WHERE user_number = 'rls-probe' AND tenant_id = $1`,
      [TENANT_B],
    );
    expect(deleted.rowCount).toBe(0);

    await app.query('ROLLBACK');

    // B's row is still intact, seen from B.
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.tenant_id = '${TENANT_B}'`);
    const { rows } = await app.query(
      `SELECT name FROM users WHERE user_number = 'rls-probe'`,
    );
    await app.query('ROLLBACK');
    expect(rows[0].name).toBe('RLS probe');
  });
});
