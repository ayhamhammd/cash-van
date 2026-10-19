import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { ClsModule } from 'nestjs-cls';
import { DataSource } from 'typeorm';

import { TenancyModule } from './tenancy.module';
import { TenantDb } from './tenant-db.service';
import { TenantScope } from './tenant-scope.service';

/**
 * Exercises the request-scoped tenant binding against a real Postgres.
 * See tenancy-rls.integration.spec.ts for how to bring the database up.
 */

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-0000000000b2';

describe('TenantScope / TenantDb', () => {
  let moduleRef: TestingModule;
  let scope: TenantScope;
  let db: TenantDb;
  let dataSource: DataSource;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              database: {
                appUsername: process.env.DB_APP_USERNAME ?? 'cashvan_app',
                appPassword: process.env.DB_APP_PASSWORD ?? 'apppw',
              },
            }),
          ],
        }),
        ClsModule.forRoot({ global: true, middleware: { mount: false } }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST ?? 'localhost',
          port: parseInt(process.env.DB_PORT ?? '55432', 10),
          username: process.env.DB_APP_USERNAME ?? 'cashvan_app',
          password: process.env.DB_APP_PASSWORD ?? 'apppw',
          database: process.env.DB_NAME ?? 'cashvan',
          // One connection makes the leak test meaningful: if the setting
          // survived the transaction, the very next query would see it.
          poolSize: 1,
          extra: { max: 1 },
          synchronize: false,
        }),
        TenancyModule,
      ],
    }).compile();

    await moduleRef.init();
    scope = moduleRef.get(TenantScope);
    db = moduleRef.get(TenantDb);
    dataSource = moduleRef.get<DataSource>(getDataSourceToken());

    const owner = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '55432', 10),
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'testpw',
      database: process.env.DB_NAME ?? 'cashvan',
    });
    await owner.initialize();
    await owner.query(
      `INSERT INTO tenants (id, code, name) VALUES ($1, 'TESTB', 'Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_B],
    );
    await owner.query(`DELETE FROM regions WHERE name_ar = 'scope-probe'`);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await owner.query(
        `INSERT INTO regions (tenant_id, name_ar) VALUES ($1, 'scope-probe')`,
        [tenant],
      );
    }
    await owner.destroy();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('scopes reads to the tenant the block runs as', async () => {
    for (const tenant of [TENANT_A, TENANT_B]) {
      const rows = await scope.runWith(tenant, () =>
        db.query<{ tenant_id: string }[]>(
          `SELECT tenant_id FROM regions WHERE name_ar = 'scope-probe'`,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(tenant);
    }
  });

  it('exposes a working repository through TenantDb', async () => {
    const count = await scope.runWith(TENANT_A, async () =>
      db.manager.query(
        `SELECT count(*)::int AS n FROM regions WHERE name_ar = 'scope-probe'`,
      ),
    );
    expect(count[0].n).toBe(1);
  });

  // The leak this whole design exists to prevent: a pooled connection carrying
  // the previous request's tenant into the next one.
  it('does not leave app.tenant_id set on the pooled connection', async () => {
    await scope.runWith(TENANT_B, () => db.query(`SELECT 1`));

    const [{ leaked }] = await dataSource.query(
      `SELECT coalesce(current_setting('app.tenant_id', true), '') AS leaked`,
    );
    expect(leaked).toBe('');

    // And the practical consequence: an unscoped read sees nothing at all.
    const rows = await dataSource.query(
      `SELECT tenant_id FROM regions WHERE name_ar = 'scope-probe'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses to hand out a manager outside a tenant scope', () => {
    expect(() => db.manager).toThrow(/No tenant-scoped database context/);
  });

  it('rolls back the whole request when the handler throws', async () => {
    await expect(
      scope.runWith(TENANT_A, async () => {
        await db.query(
          `INSERT INTO regions (name_ar) VALUES ('scope-rollback')`,
        );
        throw new Error('handler blew up');
      }),
    ).rejects.toThrow('handler blew up');

    const rows = await scope.runWith(TENANT_A, () =>
      db.query<unknown[]>(
        `SELECT 1 FROM regions WHERE name_ar = 'scope-rollback'`,
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it('lists active tenants for scheduled work', async () => {
    const ids = await scope.activeTenantIds();
    expect(ids).toEqual(expect.arrayContaining([TENANT_A, TENANT_B]));
  });
});
