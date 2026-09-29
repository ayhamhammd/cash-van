/**
 * Real-DB: customer areas — one area per customer, managed like segments.
 * Skipped unless DB_NAME points at a database with the schema applied.
 */
import { DataSource } from 'typeorm';

import { AreasService } from './areas.service';
import { CustomersService } from '../customers/customers.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;
const P = 'ZZAREA';

run('customer areas (real DB)', () => {
  let ds: DataSource;
  let areas: AreasService;
  let events: string[];
  let addressed: string[][];
  const customerIds: string[] = [];
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    await q(`UPDATE customers SET area_id = NULL WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customer_areas WHERE name_ar LIKE $1`, [`${P}%`]);
  }

  function listCustomers(query: Record<string, unknown>) {
    const svc = Object.create(CustomersService.prototype) as Record<string, unknown>;
    svc.customers = ds.getRepository('Customer');
    svc.areas = areas;
    return (svc as unknown as CustomersService).list({ limit: 50, offset: 0, q: P, ...query } as never);
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
    await purge();
    events = [];
    addressed = [];
    areas = new AreasService(
      ds.getRepository('CustomerArea') as never,
      ds.getRepository('Customer') as never,
      {
        emit: (name: string, p: { reason?: string; customerIds?: string[] }) =>
          name === 'erp.customer.area'
            ? addressed.push([...(p.customerIds ?? [])].sort())
            : events.push(p.reason ?? ''),
      } as never,
    );
    for (const n of [1, 2, 3]) {
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
    await ds.destroy();
  });

  it('creates areas and refuses a second one with the same name', async () => {
    await areas.create({ nameAr: `${P} الزرقاء` });
    await areas.create({ nameAr: `${P} الرصيفة`, color: '#3B82F6' });
    await expect(areas.create({ nameAr: `${P} الزرقاء` })).rejects.toThrow(/already exists/);
  });

  it('moves customers into an area and counts them', async () => {
    const zarqa = (await areas.list()).items.find((a) => a.nameAr === `${P} الزرقاء`)!;
    await areas.addMembers(zarqa.id, [customerIds[0], customerIds[1]]);
    const after = (await areas.list()).items.find((a) => a.id === zarqa.id)!;
    expect(after.memberCount).toBe(2);
    expect(events).toContain('area.members');
    expect(addressed.at(-1)).toEqual([customerIds[0], customerIds[1]].sort());
  });

  it('keeps a customer in one area: moving him elsewhere takes him out of the first', async () => {
    const all = (await areas.list()).items;
    const zarqa = all.find((a) => a.nameAr === `${P} الزرقاء`)!;
    const rusaifa = all.find((a) => a.nameAr === `${P} الرصيفة`)!;
    await areas.addMembers(rusaifa.id, [customerIds[1]]);
    const counts = Object.fromEntries((await areas.list()).items.map((a) => [a.id, a.memberCount]));
    expect(counts[zarqa.id]).toBe(1);
    expect(counts[rusaifa.id]).toBe(1);
  });

  it('filters the customer list by area, and by no area', async () => {
    const zarqa = (await areas.list()).items.find((a) => a.nameAr === `${P} الزرقاء`)!;
    const inZarqa = await listCustomers({ areaId: zarqa.id });
    expect(inZarqa.items.map((c) => c.id)).toEqual([customerIds[0]]);
    expect((inZarqa.items[0] as unknown as { areaName: string }).areaName).toBe(`${P} الزرقاء`);
    const none = await listCustomers({ noArea: true });
    expect(none.items.map((c) => c.id)).toEqual([customerIds[2]]);
  });

  it('refuses a deactivated area for a new customer, and says where to fix it', async () => {
    const rusaifa = (await areas.list()).items.find((a) => a.nameAr === `${P} الرصيفة`)!;
    await areas.update(rusaifa.id, { isActive: false });
    await expect(areas.assertAssignable(rusaifa.id)).rejects.toThrow(/Areas page/);
    expect((await areas.options()).some((o) => o.id === rusaifa.id)).toBe(false);
    await areas.update(rusaifa.id, { isActive: true });
  });

  it('sends every member to the ERP again when an area is renamed, and none when only its colour changes', async () => {
    const zarqa = (await areas.list()).items.find((a) => a.nameAr === `${P} الزرقاء`)!;
    addressed = [];
    await areas.update(zarqa.id, { color: '#10B981' });
    expect(addressed).toEqual([]);
    await areas.update(zarqa.id, { nameAr: `${P} الزرقاء الجديدة` });
    expect(addressed).toEqual([[customerIds[0]]]);
    await areas.update(zarqa.id, { nameAr: `${P} الزرقاء` });
  });

  it('sends a customer taken out of an area, and only when he was in it', async () => {
    const rusaifa = (await areas.list()).items.find((a) => a.nameAr === `${P} الرصيفة`)!;
    addressed = [];
    await areas.removeMember(rusaifa.id, customerIds[2]);
    expect(addressed).toEqual([]);
    await areas.removeMember(rusaifa.id, customerIds[1]);
    expect(addressed).toEqual([[customerIds[1]]]);
  });

  it('leaves its customers with no area when an area is deleted', async () => {
    addressed = [];
    const zarqa = (await areas.list()).items.find((a) => a.nameAr === `${P} الزرقاء`)!;
    await areas.remove(zarqa.id);
    const [c] = await q(`SELECT area_id FROM customers WHERE id = $1`, [customerIds[0]]);
    expect(c.area_id).toBeNull();
    expect((await areas.list()).items.some((a) => a.id === zarqa.id)).toBe(false);
    expect(addressed).toEqual([[customerIds[0]]]);
  });
});
