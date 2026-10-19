import { Logger } from '@nestjs/common';

import { TenantDataSource } from './tenant-data-source.service';

/**
 * Applies the tenant isolation policy to a table created at runtime — the
 * monthly `audit_log` and `rep_location_events` partitions.
 *
 * Reads through the partitioned PARENT are already covered by the parent's
 * policy. This is for the query that names a partition directly (a report, a
 * manual investigation), which Postgres checks against that partition's own
 * policies.
 *
 * Skips tables that are already protected, which matters more than it looks:
 * `ALTER TABLE … ENABLE ROW LEVEL SECURITY` requires OWNERSHIP, and the
 * partitions the tenancy migration created are owned by the migration role,
 * not the application role. Those are already correct, so the early return is
 * both the fast path and the only path that works. Partitions the app creates
 * itself are owned by the app, so the ALTER succeeds there.
 */
export async function ensureTenantIsolation(
  ds: TenantDataSource,
  table: string,
  logger?: Logger,
): Promise<void> {
  const rows: { ready: boolean }[] = await ds.query(
    `SELECT (relrowsecurity AND relforcerowsecurity) AS ready
     FROM pg_class WHERE relname = $1`,
    [table],
  );
  if (rows[0]?.ready) return;

  try {
    await ds.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    await ds.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    await ds.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "${table}"`);
    await ds.query(`
      CREATE POLICY "tenant_isolation" ON "${table}"
      USING      ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `);
  } catch (err) {
    // Never fail partition creation over this: the parent's policy still covers
    // every read the application actually makes. Loud enough to fix, quiet
    // enough not to take the boot down.
    logger?.warn(
      `Could not apply tenant isolation to ${table}: ${(err as Error).message}. ` +
        'Reads through the parent table remain protected; run ' +
        'ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY as the table owner.',
    );
  }
}
