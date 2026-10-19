import 'reflect-metadata';

import dataSource from '../data-source';
import { seedTenant } from './tenant-seed';

/**
 * Minimal production seed: the **transaction kinds** the vouchers module reads
 * at runtime, plus — for a single-company install only — a default admin login. NO demo business data — a fresh
 * deploy comes up empty and is filled from the ERP sync / the dashboard.
 * Idempotent: every row is upserted on a natural key, so re-running is safe.
 *
 * Runs ONCE PER COMPANY. Transaction kinds and users are per-tenant now, and a
 * pass with no tenant bound writes NULL into a NOT NULL `tenant_id` — which
 * fails the seed, and with it `start:deploy`, on every single deploy.
 */
async function seed(): Promise<void> {
  await dataSource.initialize();

  const tenants: {
    id: string;
    code: string;
    name: string;
    crmTenantId: string | null;
  }[] = await dataSource.query(
    `SELECT id, code, name, crm_tenant_id AS "crmTenantId"
       FROM tenants WHERE status = 'active' ORDER BY created_at`,
  );

  if (tenants.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('No tenants found — run the migrations first.');
    await dataSource.destroy();
    return;
  }

  for (const tenant of tenants) {
    const qr = dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      // Binds this transaction to the company, so the tenant_id column
      // defaults resolve and the policies let the writes through.
      await qr.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);

      // The default `admin` / `admin1234` login is ONLY for an install that
      // would otherwise have nobody who could sign in — a single-company or
      // on-premise deployment coming up for the first time.
      //
      // It must never reach a company provisioned from the CRM. Those get
      // their admin from the CRM, and handing them a second one with a
      // password published in every README hands the company to anyone who
      // has seen its licence key — which is on every phone and browser the
      // customer owns. That is not a theoretical leak: this loop used to run
      // `withAdmin: true` for every tenant on every deploy.
      //
      // Both conditions, not either: CRM-linked companies are excluded
      // outright, and a company that already has users does not need a
      // fallback login inventing for it.
      const isCrmLinked = tenant.crmTenantId !== null;
      const [{ count }]: { count: string }[] = await qr.query(
        `SELECT count(*)::text AS count FROM users WHERE tenant_id = $1`,
        [tenant.id],
      );
      const withAdmin = !isCrmLinked && count === '0';

      await seedTenant(qr.manager, tenant.id, {
        withAdmin,
        // The company's own name and code, not the placeholder defaults. A
        // settings row saying "My Company / C001" in every company is worse
        // than none: it looks configured, so nobody goes and fixes it.
        companyName: tenant.name,
        companyNumber: tenant.code,
      });
      await qr.commitTransaction();
      // eslint-disable-next-line no-console
      console.log(
        `Seeded ${tenant.code}: transaction kinds` +
          (withAdmin ? ' + default admin login.' : ' (no default admin).'),
      );
    } catch (err) {
      await qr.rollbackTransaction();
      // eslint-disable-next-line no-console
      console.error(`Seed failed for ${tenant.code}`, err);
      process.exitCode = 1;
    } finally {
      await qr.release();
    }
  }

  await dataSource.destroy();
}

void seed();
