/**
 * Real-DB: a product synced from the ERP keeps its category, and the van app's
 * products list names the first level of that category's branch.
 *
 * The ERP always sent each SKU's categoryId; the item sync never copied it, so
 * every ERP item arrived with no category and the app's category filter had
 * nothing to list.
 *
 * Skipped unless DB_NAME points at a database with the schema applied.
 */
import { DataSource } from 'typeorm';

import { ErpSyncService } from './erp-sync.service';
import { ProductsService } from '../products/products.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

const P = 'ZZCAT';
const ERP_ROOT = '00000000-0000-4000-8000-00000000c001';
const ERP_LEAF = '00000000-0000-4000-8000-00000000c002';

run('ERP item categories (real DB)', () => {
  let ds: DataSource;
  let rootId = '';
  let leafId = '';
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    await q(`DELETE FROM item_units WHERE item_id IN (SELECT id FROM item_cart WHERE item_number LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM item_cart WHERE item_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM erp_id_map WHERE entity = 'category' AND erp_id IN ($1,$2)`, [ERP_ROOT, ERP_LEAF]);
    await q(`DELETE FROM product_categories WHERE name_ar LIKE $1`, [`${P}%`]);
  }

  function syncService(): ErpSyncService {
    const s = Object.create(ErpSyncService.prototype) as Record<string, unknown>;
    s.dataSource = ds;
    s.items = ds.getRepository('ItemCart');
    s.itemUnits = ds.getRepository('ItemUnit');
    s.units = ds.getRepository('Unit');
    s.idmap = ds.getRepository('ErpIdMap');
    s.tobaccoProfiles = ds.getRepository('TobaccoTaxProfile');
    s.logger = { log: () => undefined, warn: () => undefined, error: () => undefined };
    return s as unknown as ErpSyncService;
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
    const [root] = await q(`INSERT INTO product_categories (name_ar) VALUES ($1) RETURNING id`, [`${P} مشروبات`]);
    const [leaf] = await q(`INSERT INTO product_categories (name_ar, parent_id) VALUES ($1,$2) RETURNING id`, [`${P} كولا`, root.id]);
    rootId = root.id;
    leafId = leaf.id;
    await q(`INSERT INTO erp_id_map (entity, erp_id, local_id) VALUES ('category',$1,$2),('category',$3,$4)`,
      [ERP_ROOT, rootId, ERP_LEAF, leafId]);
  }, 120_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  it('copies the product category from the ERP', async () => {
    await (syncService() as unknown as { upsertProductItem(s: unknown[]): Promise<boolean> }).upsertProductItem([
      { id: 's1', sku: `${P}-1`, productName: 'Cola 250', productId: 'p1', isBaseUnit: true,
        unitMultiplier: 1, sellingPrice: 0.5, categoryId: ERP_LEAF },
    ]);
    const [row] = await q(`SELECT category_id, erp_category_id FROM item_cart WHERE item_number = $1`, [`${P}-1`]);
    expect(row).toEqual({ category_id: leafId, erp_category_id: ERP_LEAF });
  });

  it('lists the product under the first level of its branch', async () => {
    const products = new ProductsService(
      ds.getRepository('ItemCart') as never,
      ds.getRepository('ItemUnit') as never,
      ds.getRepository('ProductCategory') as never,
      ds.getRepository('ItemImage') as never,
      { emit: () => undefined } as never,
    );
    const page = await products.list({ search: `${P}-1`, limit: 5, offset: 0 } as never);
    const item = page.items.find((i) => i.itemNumber === `${P}-1`) as unknown as Record<string, unknown>;
    expect(item.categoryName).toBe(`${P} كولا`);
    expect(item.topCategoryName).toBe(`${P} مشروبات`);
  });
});
