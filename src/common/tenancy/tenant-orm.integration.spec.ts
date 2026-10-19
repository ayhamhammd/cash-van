import { Injectable } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { DataSource, Repository } from 'typeorm';

import { Region } from '../../modules/regions/entities/region.entity';
import { TenancyModule } from './tenancy.module';
import { TenantOrmModule } from './tenant-orm.module';
import { TenantScope } from './tenant-scope.service';

/**
 * The point of this suite: a service written the ordinary NestJS way — plain
 * `@InjectRepository`, no awareness of tenancy at all — must end up scoped.
 * If this holds, the ~640 existing call sites need no edits.
 *
 * See tenancy-rls.integration.spec.ts for how to bring the database up.
 */

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-0000000000b2';

/** Deliberately ordinary. Nothing here knows a tenant exists. */
@Injectable()
class RegionsProbeService {
  constructor(
    @InjectRepository(Region)
    private readonly repo: Repository<Region>,
  ) {}

  findProbes(): Promise<Region[]> {
    return this.repo.find({ where: { nameAr: 'orm-probe' } });
  }

  countViaQueryBuilder(): Promise<number> {
    return this.repo
      .createQueryBuilder('r')
      .where('r.name_ar = :n', { n: 'orm-probe' })
      .getCount();
  }

  rawCount(): Promise<{ n: number }[]> {
    return this.repo.query(
      `SELECT count(*)::int AS n FROM regions WHERE name_ar = 'orm-probe'`,
    );
  }

  create(nameAr: string): Promise<Region> {
    return this.repo.save(this.repo.create({ nameAr }));
  }
}

const dbOptions = {
  type: 'postgres' as const,
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '55432', 10),
  database: process.env.DB_NAME ?? 'cashvan',
};

describe('TenantOrmModule — repositories resolve to the request tenant', () => {
  let moduleRef: TestingModule;
  let probe: RegionsProbeService;
  let scope: TenantScope;
  let owner: DataSource;

  beforeAll(async () => {
    owner = new DataSource({
      ...dbOptions,
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'testpw',
    });
    await owner.initialize();
    await owner.query(
      `INSERT INTO tenants (id, code, name) VALUES ($1, 'TESTB', 'Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_B],
    );
    await owner.query(`DELETE FROM regions WHERE name_ar IN ('orm-probe', 'orm-created')`);
    // Two rows, same name, different tenants.
    for (const tenant of [TENANT_A, TENANT_B]) {
      await owner.query(
        `INSERT INTO regions (tenant_id, name_ar) VALUES ($1, 'orm-probe')`,
        [tenant],
      );
    }

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [() => ({ database: {} })] }),
        ClsModule.forRoot({ global: true, middleware: { mount: false } }),
        TypeOrmModule.forRoot({
          ...dbOptions,
          username: process.env.DB_APP_USERNAME ?? 'cashvan_app',
          password: process.env.DB_APP_PASSWORD ?? 'apppw',
          entities: [Region],
          synchronize: false,
        }),
        TenancyModule,
        TenantOrmModule.forFeature([Region]),
      ],
      providers: [RegionsProbeService],
    }).compile();

    await moduleRef.init();
    probe = moduleRef.get(RegionsProbeService);
    scope = moduleRef.get(TenantScope);
  });

  afterAll(async () => {
    await owner?.query(`DELETE FROM regions WHERE name_ar IN ('orm-probe', 'orm-created')`);
    await owner?.destroy();
    await moduleRef?.close();
  });

  // Two rows exist with this name, one per tenant. Seeing exactly one — and a
  // different one each time — is the whole proof.
  it('scopes repository.find to the active tenant', async () => {
    const a = await scope.runWith(TENANT_A, () => probe.findProbes());
    const b = await scope.runWith(TENANT_B, () => probe.findProbes());

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].id).not.toBe(b[0].id);

    const { rows: owned } = await owner
      .query(
        `SELECT id, tenant_id FROM regions WHERE name_ar = 'orm-probe' ORDER BY tenant_id`,
      )
      .then((r: { id: string; tenant_id: string }[]) => ({ rows: r }));
    expect(owned).toHaveLength(2);
    expect(owned.find((r) => r.tenant_id === TENANT_A)?.id).toBe(a[0].id);
    expect(owned.find((r) => r.tenant_id === TENANT_B)?.id).toBe(b[0].id);
  });

  it('scopes createQueryBuilder', async () => {
    const a = await scope.runWith(TENANT_A, () => probe.countViaQueryBuilder());
    expect(a).toBe(1);
  });

  it('scopes raw repository.query', async () => {
    const rows = await scope.runWith(TENANT_B, () => probe.rawCount());
    expect(rows[0].n).toBe(1);
  });

  it('stamps the active tenant on save()', async () => {
    const created = await scope.runWith(TENANT_B, () => probe.create('orm-created'));
    expect(created.id).toBeDefined();

    const { rows } = await owner
      .query(`SELECT tenant_id FROM regions WHERE name_ar = 'orm-created'`)
      .then((r: { tenant_id: string }[]) => ({ rows: r }));
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(TENANT_B);
  });

  it('sees nothing outside a tenant scope', async () => {
    await expect(probe.findProbes()).resolves.toHaveLength(0);
  });

  // The injected repository is a single shared instance. If it resolved its
  // manager once instead of per access, these two would collide.
  it('keeps concurrent requests on different tenants apart', async () => {
    const [a, b] = await Promise.all([
      scope.runWith(TENANT_A, () => probe.findProbes()),
      scope.runWith(TENANT_B, () => probe.findProbes()),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].id).not.toBe(b[0].id);
  });
});
