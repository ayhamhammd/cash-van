/**
 * Real-DB: salesmen by area (docs/SPEC-location-tree.md §5).
 *
 *  - an area's salesman takes every customer in it without one of their own;
 *    a customer assigned directly keeps his;
 *  - an area without a salesman inherits the nearest one above it;
 *  - a dry run reports exactly what the real run then does, and writes nothing;
 *  - moving an area to another governorate re-resolves its customers;
 *  - in FLAT mode an assignment is stored and moves nobody until the switch;
 *  - choosing a salesman on the customer makes him DIRECT, and "use the
 *    area's salesman" hands the customer back.
 *
 * Skipped unless DB_NAME points at a database with the schema applied. Uses
 * two existing reps; creates and removes everything else under ZZREP.
 */
import { DataSource, QueryRunner } from 'typeorm';

import { CustomersService } from '../customers/customers.service';
import { LocationMode } from '../settings/entities/app-settings.entity';
import { LocationTreeService } from './locations.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;
const P = 'ZZREP';

run('salesmen by area (real DB)', () => {
  let ds: DataSource;
  let tree: LocationTreeService;
  let mode: LocationMode = 'TREE';
  let signals: Array<{ repId?: string | null; reason?: string }>;
  let repA = '';
  let repB = '';
  let rootId = '';
  let createdRoot = false;
  let govN = '';
  let govS = '';
  let areaN1 = '';
  let areaN2 = '';
  const c: string[] = [];
  let lock: QueryRunner;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const repOf = async (id: string) =>
    (await q(`SELECT rep_id, rep_source FROM customers WHERE id = $1`, [id]))[0] as {
      rep_id: string | null;
      rep_source: string | null;
    };

  const settings = {
    locationMode: async () => mode,
    setLocationMode: async (m: LocationMode) => {
      mode = m;
    },
  };

  async function purge() {
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`UPDATE locations SET rep_id = NULL WHERE name_ar LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM locations WHERE kind = 'AREA' AND name_ar LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM locations WHERE kind = 'GOVERNORATE' AND name_ar LIKE $1`, [`${P}%`]);
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
    const reps = await q(`SELECT id FROM reps WHERE deleted_at IS NULL AND is_active ORDER BY id LIMIT 2`);
    [repA, repB] = reps.map((r: { id: string }) => r.id);
    signals = [];
    tree = new LocationTreeService(
      ds.getRepository('Location') as never,
      ds.getRepository('Customer') as never,
      ds.getRepository('CustomerArea') as never,
      ds,
      settings as never,
      {
        emit: (name: string, p: { repId?: string | null; reason?: string }) => {
          if (name === 'customer.changed') signals.push(p);
        },
      } as never,
    );
    const root = (await q(`SELECT id FROM locations WHERE parent_id IS NULL AND deleted_at IS NULL`))[0];
    if (root) rootId = root.id;
    else {
      rootId = (await tree.create({ nameAr: `${P} دولة` })).id;
      createdRoot = true;
    }
    govN = (await tree.create({ parentId: rootId, nameAr: `${P} الشمال`, code: 'ZZ-RN' })).id;
    govS = (await tree.create({ parentId: rootId, nameAr: `${P} الجنوب`, code: 'ZZ-RS' })).id;
    areaN1 = (await tree.create({ parentId: govN, nameAr: `${P} حي 1` })).id;
    areaN2 = (await tree.create({ parentId: govN, nameAr: `${P} حي 2` })).id;
    // c0, c1: in area N1, no salesman. c2: in N1, assigned DIRECT to B. c3: in N2.
    for (const n of [0, 1, 2, 3]) {
      const [row] = await q(
        `INSERT INTO customers (customer_number, customer_name, name_ar, location_id, rep_id, rep_source)
         VALUES ($1, $1, $1, $2, $3, $4) RETURNING id`,
        [`${P}-C${n}`, n === 3 ? areaN2 : areaN1, n === 2 ? repB : null, n === 2 ? 'DIRECT' : null],
      );
      c.push(row.id);
    }
  }, 120_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    if (createdRoot) await q(`DELETE FROM locations WHERE id = $1`, [rootId]);
    await lock.query(`SELECT pg_advisory_unlock(hashtext('location-tree-tests'))`);
    await lock.release();
    await ds.destroy();
  });

  it('previews an area assignment exactly, and writes nothing', async () => {
    const dry = await tree.setRep(areaN1, repA, true);
    expect(dry).toMatchObject({ dryRun: true, applied: true, moved: 2, keptDirect: 1 });
    expect(dry.byRep).toEqual([expect.objectContaining({ fromRepId: null, toRepId: repA, count: 2 })]);
    expect((await repOf(c[0])).rep_id).toBeNull();
    expect((await q(`SELECT rep_id FROM locations WHERE id = $1`, [areaN1]))[0].rep_id).toBeNull();
  });

  it("gives the area's customers its salesman, and leaves a direct one alone", async () => {
    signals = [];
    const r = await tree.setRep(areaN1, repA);
    expect(r).toMatchObject({ dryRun: false, moved: 2, keptDirect: 1 });
    expect(await repOf(c[0])).toEqual({ rep_id: repA, rep_source: 'AREA' });
    expect(await repOf(c[1])).toEqual({ rep_id: repA, rep_source: 'AREA' });
    expect(await repOf(c[2])).toEqual({ rep_id: repB, rep_source: 'DIRECT' });
    expect((await repOf(c[3])).rep_id).toBeNull(); // the other area is not touched
    // One signal for the salesman who gained shops, not one per customer.
    expect(signals.filter((s) => s.reason === 'location.rep' && s.repId === repA)).toHaveLength(1);
  });

  it('lets an area without a salesman inherit its governorate', async () => {
    await tree.setRep(govN, repB);
    expect(await repOf(c[3])).toEqual({ rep_id: repB, rep_source: 'AREA' });
    expect(await repOf(c[0])).toEqual({ rep_id: repA, rep_source: 'AREA' }); // its own area wins
    const { items } = await tree.list();
    const n2 = items.find((i) => i.id === areaN2)!;
    expect(n2).toMatchObject({ repId: null, inheritedRepId: repB });
  });

  it("falls to the next salesman up when an area's is taken away", async () => {
    await tree.setRep(areaN1, null);
    expect(await repOf(c[0])).toEqual({ rep_id: repB, rep_source: 'AREA' });
    await tree.setRep(govN, null);
    expect(await repOf(c[0])).toEqual({ rep_id: null, rep_source: null });
    expect(await repOf(c[3])).toEqual({ rep_id: null, rep_source: null });
    expect(await repOf(c[2])).toEqual({ rep_id: repB, rep_source: 'DIRECT' });
  });

  it('re-resolves an area moved to another governorate', async () => {
    await tree.setRep(govS, repA);
    await tree.update(areaN2, { parentId: govS });
    expect(await repOf(c[3])).toEqual({ rep_id: repA, rep_source: 'AREA' });
    await tree.update(areaN2, { parentId: govN });
    expect(await repOf(c[3])).toEqual({ rep_id: null, rep_source: null });
    await tree.setRep(govS, null);
  });

  it('stores an assignment in FLAT mode without moving anyone, and applies it on the switch', async () => {
    mode = 'FLAT';
    const r = await tree.setRep(areaN1, repA);
    expect(r).toMatchObject({ applied: false, moved: 0 });
    expect((await repOf(c[0])).rep_id).toBeNull();
    // The switch preview counts the move; the switch makes it.
    const placed = Number((await q(`SELECT COUNT(*) AS n FROM locations WHERE kind='AREA' AND deleted_at IS NULL AND is_active`))[0].n);
    expect(placed).toBeGreaterThan(0);
    const dry = await tree.switchMode('TREE', true);
    expect(dry.reps.moved).toBeGreaterThanOrEqual(2);
    expect(mode).toBe('FLAT');
    await tree.switchMode('TREE');
    expect(mode).toBe('TREE');
    expect(await repOf(c[0])).toEqual({ rep_id: repA, rep_source: 'AREA' });
  });

  it("makes a chosen salesman the customer's own, and hands the customer back to the area on request", async () => {
    const svc = Object.create(CustomersService.prototype) as Record<string, unknown>;
    svc.customers = ds.getRepository('Customer');
    svc.locations = tree;
    svc.settings = settings;
    svc.events = { emit: () => true };
    svc.areas = { assertAssignable: async () => undefined };
    const customers = svc as unknown as CustomersService;

    await customers.update(c[0], { repId: repB }, { canAssignSalesman: true });
    expect(await repOf(c[0])).toEqual({ rep_id: repB, rep_source: 'DIRECT' });
    // The area's salesman changing no longer moves it.
    await tree.setRep(areaN1, null);
    await tree.setRep(areaN1, repA);
    expect(await repOf(c[0])).toEqual({ rep_id: repB, rep_source: 'DIRECT' });

    const back = await customers.useAreaSalesman(c[0]);
    expect(back.repId).toBe(repA);
    expect(await repOf(c[0])).toEqual({ rep_id: repA, rep_source: 'AREA' });

    // Placed in another area, a customer that follows its area follows it.
    await customers.update(c[1], { locationId: areaN2 }, { canAssignSalesman: true });
    expect(await repOf(c[1])).toEqual({ rep_id: null, rep_source: null });
  });

  it("hands a deactivated salesman's area customers to the next one up, and back when he returns", async () => {
    const mk = async (code: string) =>
      (await q(`INSERT INTO reps (code, name_ar) VALUES ($1, $1) RETURNING id`, [code]))[0].id as string;
    const up = await mk(`${P}-UP`);
    const own = await mk(`${P}-OWN`);
    await tree.setRep(govS, up);
    await tree.setRep(areaN2, null);
    await tree.update(areaN2, { parentId: govS });
    await tree.setRep(areaN2, own);
    expect(await repOf(c[3])).toEqual({ rep_id: own, rep_source: 'AREA' });

    await q(`UPDATE reps SET is_active = false WHERE id = $1`, [own]);
    await tree.onRepActiveChanged();
    expect(await repOf(c[3])).toEqual({ rep_id: up, rep_source: 'AREA' });
    const n2 = (await tree.list()).items.find((i) => i.id === areaN2)!;
    expect(n2).toMatchObject({ repId: own, repActive: false, inheritedRepId: up });

    // An inactive salesman cannot be given an area.
    await expect(tree.setRep(govN, own)).rejects.toThrow(/inactive/);

    await q(`UPDATE reps SET is_active = true WHERE id = $1`, [own]);
    await tree.onRepActiveChanged();
    expect(await repOf(c[3])).toEqual({ rep_id: own, rep_source: 'AREA' });

    // Deleted counts as gone too.
    await q(`UPDATE reps SET deleted_at = now() WHERE id = $1`, [own]);
    await tree.onRepActiveChanged();
    expect(await repOf(c[3])).toEqual({ rep_id: up, rep_source: 'AREA' });

    await tree.setRep(areaN2, null);
    await tree.update(areaN2, { parentId: govN });
    await tree.setRep(govS, null);
  });

  it('lets other salesmen also serve a place or one shop, without changing its main salesman', async () => {
    const mk = async (code: string) =>
      (await q(`INSERT INTO reps (code, name_ar) VALUES ($1, $1) RETURNING id`, [code]))[0].id as string;
    const snacks = await mk(`${P}-SNK`);
    const ice = await mk(`${P}-ICE`);
    const svc = Object.create(CustomersService.prototype) as Record<string, unknown>;
    svc.customers = ds.getRepository('Customer');
    svc.locations = tree;
    svc.settings = settings;
    svc.events = { emit: () => true };
    svc.areas = { namesById: async () => new Map() };
    const customers = svc as unknown as CustomersService;
    const phoneList = async (repId: string) =>
      (
        await customers.list({ limit: 50, offset: 0, q: P, repId } as never, null, { forSalesman: true })
      ).items.map((i) => i.id);
    const modeBefore = (await q(`SELECT location_mode FROM app_settings WHERE id = 1`))[0].location_mode;
    await q(`UPDATE app_settings SET location_mode = 'TREE' WHERE id = 1`);
    try {
      const mainBefore = await Promise.all(c.map(repOf));

      // A governorate's extra salesman serves every shop in its areas.
      await tree.setExtraReps(govN, [snacks]);
      expect((await phoneList(snacks)).sort()).toEqual([...c].sort());
      const items = (await tree.list()).items;
      expect(items.find((i) => i.id === govN)!.extraReps).toEqual([
        expect.objectContaining({ repId: snacks, active: true }),
      ]);
      expect(items.find((i) => i.id === areaN1)!.inheritedExtraReps).toEqual([
        expect.objectContaining({ repId: snacks }),
      ]);

      // One shop can be given one more of its own.
      await customers.setExtraReps(c[0], [ice]);
      expect(await phoneList(ice)).toEqual([c[0]]);
      const one = await customers.getWithPlace(c[0]);
      const also = (one as unknown as { alsoServedBy: Array<{ repId: string; source: string }> }).alsoServedBy;
      expect(also.map((a) => [a.repId, a.source]).sort()).toEqual(
        [[ice, 'DIRECT'], [snacks, 'AREA']].sort(),
      );
      // The phone tells him it is not his own shop.
      const row = (
        await customers.list({ limit: 50, offset: 0, q: P, repId: ice } as never, null, { forSalesman: true })
      ).items[0] as unknown as { servedAs: string };
      expect(row.servedAs).toBe('ALSO');

      // Nobody's main salesman moved; the office's "by salesman" filter is still the main one.
      expect(await Promise.all(c.map(repOf))).toEqual(mainBefore);
      const office = await customers.list({ limit: 50, offset: 0, q: P, repId: snacks } as never, null, {});
      expect(office.items).toHaveLength(0);

      // An inactive salesman cannot be added.
      await q(`UPDATE reps SET is_active = false WHERE id = $1`, [ice]);
      await expect(tree.setExtraReps(govS, [ice])).rejects.toThrow(/inactive/);

      // Places only count in TREE mode; a shop's own extra still does.
      await q(`UPDATE app_settings SET location_mode = 'FLAT' WHERE id = 1`);
      expect(await phoneList(snacks)).toEqual([]);
      expect(await phoneList(ice)).toEqual([c[0]]);
    } finally {
      await q(`UPDATE app_settings SET location_mode = $1 WHERE id = 1`, [modeBefore]);
      await tree.setExtraReps(govN, []);
      await q(`DELETE FROM customer_extra_reps WHERE rep_id = ANY($1::uuid[])`, [[snacks, ice]]);
    }
  });
});
