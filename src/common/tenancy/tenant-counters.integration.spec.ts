import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { DataSource } from 'typeorm';

import { TenancyModule } from './tenancy.module';
import { TenantCounters } from './tenant-counters.service';
import { TenantScope } from './tenant-scope.service';

/** See tenancy-rls.integration.spec.ts for how to bring the database up. */

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-0000000000b2';

describe('TenantCounters — document numbering is per tenant', () => {
  let moduleRef: TestingModule;
  let counters: TenantCounters;
  let scope: TenantScope;
  let owner: DataSource;

  beforeAll(async () => {
    const conn = {
      type: 'postgres' as const,
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '55432', 10),
      database: process.env.DB_NAME ?? 'cashvan',
    };

    owner = new DataSource({
      ...conn,
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'testpw',
    });
    await owner.initialize();
    await owner.query(
      `INSERT INTO tenants (id, code, name) VALUES ($1, 'TESTB', 'Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_B],
    );
    await owner.query(`DELETE FROM tenant_counters WHERE name = 'invoice'`);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [() => ({ database: {} })] }),
        ClsModule.forRoot({ global: true, middleware: { mount: false } }),
        TypeOrmModule.forRoot({
          ...conn,
          username: process.env.DB_APP_USERNAME ?? 'cashvan_app',
          password: process.env.DB_APP_PASSWORD ?? 'apppw',
          entities: [],
          synchronize: false,
        }),
        TenancyModule,
      ],
    }).compile();

    await moduleRef.init();
    counters = moduleRef.get(TenantCounters);
    scope = moduleRef.get(TenantScope);
  });

  afterAll(async () => {
    await owner?.destroy();
    await moduleRef?.close();
  });

  it('starts each tenant at 1 and never shares a number', async () => {
    // Interleaved on purpose: a shared sequence would produce 1,2,3,4.
    const a1 = await scope.runWith(TENANT_A, () => counters.next('invoice'));
    const b1 = await scope.runWith(TENANT_B, () => counters.next('invoice'));
    const a2 = await scope.runWith(TENANT_A, () => counters.next('invoice'));
    const b2 = await scope.runWith(TENANT_B, () => counters.next('invoice'));

    expect([a1, a2]).toEqual([1, 2]);
    expect([b1, b2]).toEqual([1, 2]);
  });

  it('keeps separate series per counter name', async () => {
    const invoice = await scope.runWith(TENANT_A, () => counters.next('invoice'));
    const customer = await scope.runWith(TENANT_A, () => counters.next('customer'));
    expect(invoice).toBe(3);
    // The customer series was seeded from its old sequence, so it only has to
    // be independent of the invoice series, not equal to it.
    expect(customer).toBeGreaterThan(0);
  });

  it('writes the counter row against the right tenant', async () => {
    const rows: { tenant_id: string; value: string }[] = await owner.query(
      `SELECT tenant_id, value FROM tenant_counters WHERE name = 'invoice' ORDER BY tenant_id`,
    );
    const byTenant = new Map(rows.map((r) => [r.tenant_id, Number(r.value)]));
    expect(byTenant.get(TENANT_A)).toBe(3);
    expect(byTenant.get(TENANT_B)).toBe(2);
  });

  it('is gap-free under concurrent numbering within one tenant', async () => {
    await owner.query(
      `DELETE FROM tenant_counters WHERE name = 'vendor' AND tenant_id = $1`,
      [TENANT_B],
    );
    const issued = await Promise.all(
      Array.from({ length: 10 }, () =>
        scope.runWith(TENANT_B, () => counters.next('vendor')),
      ),
    );
    expect([...issued].sort((x, y) => x - y)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });
});
