/**
 * Real-DB: the location tree (country › governorate › area), the FLAT/TREE
 * switch, and the customer side — placing, filtering, labels, and what an old
 * app build sees in TREE mode. Skipped unless DB_NAME points at a database
 * with the schema applied.
 *
 * Builds its tree with the Jordan seed when the database has none, and then
 * removes the whole tree again; on a database that already has one it only
 * adds (and removes) areas prefixed ZZLOC.
 */
import { plainToInstance } from 'class-transformer';
import { DataSource, QueryRunner } from 'typeorm';

import { CustomersService } from '../customers/customers.service';
import { ListCustomersQuery } from '../customers/dto/list-customers.query';
import { AreasService } from '../areas/areas.service';
import { LocationMode } from '../settings/entities/app-settings.entity';
import { LocationTreeService } from './locations.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;
const P = 'ZZLOC';

run('location tree (real DB)', () => {
  let ds: DataSource;
  let locations: LocationTreeService;
  let mode: LocationMode = 'FLAT';
  let modeBefore: LocationMode = 'FLAT';
  let treeExisted = false;
  let reasons: string[];
  let addressed: string[][];
  const customerIds: string[] = [];
  let amman = '';
  let irbid = '';
  let lock: QueryRunner;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  const settings = {
    locationMode: async () => mode,
    setLocationMode: async (m: LocationMode) => {
      mode = m;
    },
  };

  function customersService(): CustomersService {
    const svc = Object.create(CustomersService.prototype) as Record<string, unknown>;
    svc.customers = ds.getRepository('Customer');
    svc.areas = new AreasService(ds.getRepository('CustomerArea') as never, ds.getRepository('Customer') as never, {
      emit: () => true,
    } as never);
    svc.locations = locations;
    svc.settings = settings;
    return svc as unknown as CustomersService;
  }

  function listCustomers(query: Record<string, unknown>, forSalesman = false) {
    return customersService().list({ limit: 50, offset: 0, q: P, ...query } as never, null, { forSalesman });
  }

  async function purge() {
    await q(`UPDATE customers SET location_id = NULL, area_id = NULL WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customer_areas WHERE name_ar LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM locations WHERE name_ar LIKE $1`, [`${P}%`]);
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'cashvan',
      database: process.env.DB_NAME as string,
      entities: [__dirname + '/../../**/*.entity.{ts,js}'],
      synchronize: false,
    });
    await ds.initialize();
    // The tree has ONE root, shared by every suite that builds one: take turns.
    lock = ds.createQueryRunner();
    await lock.connect();
    await lock.query(`SELECT pg_advisory_lock(hashtext('location-tree-tests'))`);
    await purge();
    treeExisted = Number((await q(`SELECT COUNT(*) AS n FROM locations WHERE deleted_at IS NULL`))[0].n) > 0;
    modeBefore = (await q(`SELECT location_mode FROM app_settings WHERE id = 1`))[0]?.location_mode ?? 'FLAT';
    reasons = [];
    addressed = [];
    locations = new LocationTreeService(
      ds.getRepository('Location') as never,
      ds.getRepository('Customer') as never,
      ds.getRepository('CustomerArea') as never,
      ds,
      settings as never,
      {
        emit: (name: string, p: { reason?: string; customerIds?: string[] }) =>
          name === 'erp.customer.area'
            ? addressed.push([...(p.customerIds ?? [])].sort())
            : reasons.push(p.reason ?? ''),
      } as never,
    );
    for (const n of [1, 2, 3, 4]) {
      const [c] = await q(
        `INSERT INTO customers (customer_number, customer_name, name_ar) VALUES ($1,$1,$1) RETURNING id`,
        [`${P}-C${n}`],
      );
      customerIds.push(c.id);
    }
  }, 120_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    if (!treeExisted) {
      // Children before parents: the parent FK is ON DELETE RESTRICT.
      await q(`DELETE FROM locations WHERE kind = 'AREA'`);
      await q(`DELETE FROM locations WHERE kind = 'GOVERNORATE'`);
      await q(`DELETE FROM locations WHERE kind = 'COUNTRY'`);
    }
    await q(`UPDATE app_settings SET location_mode = $1 WHERE id = 1`, [modeBefore]);
    await lock.query(`SELECT pg_advisory_unlock(hashtext('location-tree-tests'))`);
    await lock.release();
    await ds.destroy();
  });

  it('seeds Jordan and its 12 governorates once, and again adds nothing', async () => {
    const first = await locations.seedJordan();
    const second = await locations.seedJordan();
    expect(second.created).toBe(0);
    if (!treeExisted) expect(first.created).toBe(13);
    const govs = await q(
      `SELECT code FROM locations WHERE kind = 'GOVERNORATE' AND deleted_at IS NULL AND code LIKE 'JO-%'`,
    );
    expect(govs.length).toBeGreaterThanOrEqual(12);
    amman = (await q(`SELECT id FROM locations WHERE code = 'JO-AM' AND deleted_at IS NULL`))[0].id;
    irbid = (await q(`SELECT id FROM locations WHERE code = 'JO-IR' AND deleted_at IS NULL`))[0].id;
  });

  it('refuses to switch to the tree while it has no areas', async () => {
    const areas = Number((await q(`SELECT COUNT(*) AS n FROM locations WHERE kind = 'AREA' AND deleted_at IS NULL AND is_active`))[0].n);
    if (areas > 0) return; // a database that already has areas cannot show this
    await expect(locations.switchMode('TREE')).rejects.toMatchObject({
      response: { code: 'LOCATION_TREE_EMPTY' },
    });
    expect(mode).toBe('FLAT');
  });

  it('derives each kind from its parent, and an area takes no children', async () => {
    const area = await locations.create({ parentId: amman, nameAr: `${P} الجبيهة` });
    expect(area.kind).toBe('AREA');
    expect(area.depth).toBe(2);
    expect(area.path.startsWith((await locations.getOne(amman)).path)).toBe(true);
    await expect(locations.create({ parentId: area.id, nameAr: `${P} شارع` })).rejects.toMatchObject({
      response: { code: 'LOCATION_TOO_DEEP' },
    });
    await expect(locations.create({ nameAr: `${P} دولة ثانية` })).rejects.toMatchObject({
      response: { code: 'LOCATION_ROOT_EXISTS' },
    });
    await expect(locations.create({ parentId: amman, nameAr: `${P} الجبيهة` })).rejects.toThrow(/already exists/);
  });

  it('keeps governorate codes unique, upper-cased', async () => {
    const root = (await q(`SELECT id FROM locations WHERE parent_id IS NULL AND deleted_at IS NULL`))[0].id;
    await expect(locations.create({ parentId: root, nameAr: `${P} عمّان ثانية`, code: 'jo-am' })).rejects.toThrow(
      /JO-AM already belongs/,
    );
    const gov = await locations.create({ parentId: root, nameAr: `${P} محافظة`, code: 'zz-t1' });
    expect(gov.code).toBe('ZZ-T1');
    await locations.remove(gov.id);
  });

  it('places customers, fills an empty JoFotara city code from the governorate, and counts them up the tree', async () => {
    const area = (await q(`SELECT id FROM locations WHERE name_ar = $1`, [`${P} الجبيهة`]))[0].id;
    await q(`UPDATE customers SET city_code = 'JO-ZZ' WHERE id = $1`, [customerIds[1]]);
    addressed = [];
    mode = 'TREE';
    await locations.addMembers(area, [customerIds[0], customerIds[1]]);
    mode = 'FLAT';
    const codes = await q(`SELECT id, city_code FROM customers WHERE id = ANY($1::uuid[])`, [customerIds.slice(0, 2)]);
    const byId = new Map(codes.map((r: { id: string; city_code: string }) => [r.id, r.city_code]));
    expect(byId.get(customerIds[0])).toBe('JO-AM');
    expect(byId.get(customerIds[1])).toBe('JO-ZZ'); // a code already set is kept
    expect(addressed).toEqual([[customerIds[0], customerIds[1]].sort()]);

    const { items } = await locations.list();
    const ammanRow = items.find((i) => i.id === amman)!;
    const areaRow = items.find((i) => i.id === area)!;
    expect(areaRow.customerCount).toBe(2);
    expect(ammanRow.customerCount).toBe(0);
    expect(ammanRow.subtreeCustomerCount).toBeGreaterThanOrEqual(2);
  });

  it('filters customers by a governorate through its areas, and labels them', async () => {
    const byGov = await listCustomers({ locationId: amman });
    expect(byGov.items.map((c) => c.id).sort()).toEqual([customerIds[0], customerIds[1]].sort());
    const row = byGov.items[0] as unknown as Record<string, unknown>;
    expect(row.governorateCode).toBe('JO-AM');
    expect(row.locationLabel).toBe(`عمّان - ${P} الجبيهة`);
    const none = await listCustomers({ noLocation: true });
    expect(none.items.map((c) => c.id).sort()).toEqual([customerIds[2], customerIds[3]].sort());
  });

  it('reads ?noLocation=false as false — the old Boolean() cast read it as true', () => {
    const parsed = plainToInstance(ListCustomersQuery, { noLocation: 'false', noArea: 'false', unassigned: 'true' }, {
      enableImplicitConversion: true,
    });
    expect(parsed.noLocation).toBe(false);
    expect(parsed.noArea).toBe(false);
    expect(parsed.unassigned).toBe(true);
  });

  it('moves an area to another governorate, and its customers follow', async () => {
    const area = (await q(`SELECT id FROM locations WHERE name_ar = $1`, [`${P} الجبيهة`]))[0].id;
    await locations.update(area, { parentId: irbid });
    const moved = await locations.getOne(area);
    expect(moved.path.startsWith((await locations.getOne(irbid)).path)).toBe(true);
    const labels = await locations.labels([area]);
    expect(labels.get(area)?.governorateCode).toBe('JO-IR');
    expect((await listCustomers({ locationId: irbid })).total).toBe(2);
    expect((await listCustomers({ locationId: amman })).total).toBe(0);
    await locations.update(area, { parentId: amman });
  });

  it('refuses to delete a place with customers or children', async () => {
    const area = (await q(`SELECT id FROM locations WHERE name_ar = $1`, [`${P} الجبيهة`]))[0].id;
    await expect(locations.remove(area)).rejects.toMatchObject({ response: { code: 'LOCATION_HAS_CUSTOMERS' } });
    await expect(locations.remove(amman)).rejects.toMatchObject({ response: { code: 'LOCATION_HAS_CHILDREN' } });
  });

  it('will not file a customer under a governorate, or under a deactivated one', async () => {
    await expect(locations.assertAssignableArea(amman)).rejects.toMatchObject({
      response: { code: 'LOCATION_NOT_AN_AREA' },
    });
    const area = await locations.create({ parentId: irbid, nameAr: `${P} الحصن` });
    await locations.update(irbid, { isActive: false });
    await expect(locations.assertAssignableArea(area.id)).rejects.toThrow(/deactivated/);
    const options = await locations.options();
    expect(options[0].children.some((g) => g.id === irbid)).toBe(false);
    await locations.update(irbid, { isActive: true });
  });

  it('brings a flat area into the tree, and running it twice reuses the area', async () => {
    const [flat] = await q(`INSERT INTO customer_areas (name_ar, color) VALUES ($1, '#10B981') RETURNING id`, [
      `${P} ماركا`,
    ]);
    await q(`UPDATE customers SET area_id = $1 WHERE id = $2`, [flat.id, customerIds[2]]);
    const first = await locations.importFlat({ mapping: [{ areaId: flat.id, governorateId: amman }] });
    expect(first).toMatchObject({ created: 1, reused: 0, customersPlaced: 1 });
    const second = await locations.importFlat({ mapping: [{ areaId: flat.id, governorateId: amman }] });
    expect(second).toMatchObject({ created: 0, reused: 1, customersPlaced: 1 });
    const [c] = await q(`SELECT area_id, location_id FROM customers WHERE id = $1`, [customerIds[2]]);
    expect(c.area_id).toBe(flat.id); // the flat area is kept for a switch back
    expect((await locations.labels([c.location_id])).get(c.location_id)?.locationName).toBe(`${P} ماركا`);
  });

  it('switches to the tree only for real when not a dry run', async () => {
    mode = 'FLAT';
    const dry = await locations.switchMode('TREE', true);
    expect(dry).toMatchObject({ from: 'FLAT', mode: 'TREE', changed: true, dryRun: true });
    expect(mode).toBe('FLAT');
    reasons = [];
    await locations.switchMode('TREE');
    expect(mode).toBe('TREE');
    expect(reasons).toContain('location.mode');
  });

  it('gives an old app build the tree areas through its flat fields and picker', async () => {
    mode = 'TREE';
    const svc = customersService();
    const options = await svc.areaOptions();
    const jubeiha = (await q(`SELECT id FROM locations WHERE name_ar = $1`, [`${P} الجبيهة`]))[0].id;
    expect(options.find((o) => o.id === jubeiha)?.nameAr).toBe(`عمّان - ${P} الجبيهة`);

    const asSalesman = await listCustomers({ locationId: amman }, true);
    const row = asSalesman.items.find((c) => c.id === customerIds[0]) as unknown as Record<string, unknown>;
    expect(row.areaId).toBe(jubeiha);
    expect(row.areaName).toBe(`عمّان - ${P} الجبيهة`);
    const asOffice = await listCustomers({ locationId: amman }, false);
    expect((asOffice.items.find((c) => c.id === customerIds[0]) as unknown as Record<string, unknown>).areaId).toBeNull();

    const translated = await (svc as unknown as {
      withTreeArea: (d: { areaId?: string; locationId?: string }) => Promise<{ areaId?: string; locationId?: string }>;
    }).withTreeArea({ areaId: jubeiha });
    expect(translated).toEqual({ areaId: undefined, locationId: jubeiha });
    mode = 'FLAT';
    const untouched = await (svc as unknown as {
      withTreeArea: (d: { areaId?: string }) => Promise<{ areaId?: string; locationId?: string }>;
    }).withTreeArea({ areaId: jubeiha });
    expect(untouched).toEqual({ areaId: jubeiha });
  });
});
