import { ErpSyncService } from './erp-sync.service';

/**
 * Regression for the vanishing product image. The catalogue sweep used to run
 * `item.imageUrl = absoluteImageUrl(base.imageUrl, erpOrigin)` unconditionally, so
 * any sweep where the ERP row carried no image, or a relative path that couldn't
 * be resolved (erpOrigin momentarily unavailable), blanked an image the item was
 * already showing. The fix only overwrites when the sweep yields a usable image.
 *
 * A single base-unit SKU is used so the item_units loop is skipped and the method
 * only touches the `items` repo (arg 3) and `idmap` repo (arg 17).
 */
type Existing = { id: string; itemNumber: string; imageUrl: string | null } | null;

function baseSku(imageUrl: string | null) {
  return {
    id: 'erp-1',
    sku: 'SKU-1',
    productName: 'Widget',
    barcode: null as string | null,
    sellingPrice: 1,
    unitCost: 0.5,
    isActive: true,
    isBaseUnit: true,
    unitMultiplier: 1,
    isTobaccoProduct: false,
    imageUrl,
  };
}

function makeSvc(existing: Existing) {
  const saved: Array<{ imageUrl: string | null }> = [];
  const items = {
    findOne: jest.fn(({ where }: { where: { itemNumber?: string; barcode?: string } }) => {
      if (where.itemNumber !== undefined) return Promise.resolve(existing); // the item lookup
      if (where.barcode !== undefined) return Promise.resolve(null); // barcode is free
      return Promise.resolve(null);
    }),
    create: jest.fn((x: Record<string, unknown>) => ({ ...x })),
    save: jest.fn((x: { imageUrl: string | null }) => {
      saved.push({ imageUrl: x.imageUrl });
      return Promise.resolve(x);
    }),
    delete: jest.fn(() => Promise.resolve()),
  };
  const idmap = {
    findOne: jest.fn(() => Promise.resolve(null)),
    create: jest.fn((x: Record<string, unknown>) => ({ ...x })),
    save: jest.fn(() => Promise.resolve()),
  };
  const svc = Object.create(ErpSyncService.prototype) as ErpSyncService;
  (svc as unknown as { items: unknown }).items = items;
  (svc as unknown as { idmap: unknown }).idmap = idmap;
  (svc as unknown as { logger: unknown }).logger = { warn: jest.fn(), log: jest.fn() };
  const upsert = (skus: unknown[], origin: string | null) =>
    (svc as unknown as {
      upsertProductItem(s: unknown[], o: string | null): Promise<boolean>;
    }).upsertProductItem(skus, origin);
  return { upsert, saved };
}

describe('ErpSyncService item image — never blanked by a sweep', () => {
  it('preserves the existing image when the ERP sweep carries no image', async () => {
    const existing = { id: 'itm-1', itemNumber: 'SKU-1', imageUrl: 'https://erp.example/old.png' };
    const { upsert } = makeSvc(existing);
    await upsert([baseSku(null)], 'https://erp.example');
    expect(existing.imageUrl).toBe('https://erp.example/old.png'); // untouched
  });

  it('preserves the existing image when a relative path cannot be resolved (no origin)', async () => {
    const existing = { id: 'itm-1', itemNumber: 'SKU-1', imageUrl: 'https://erp.example/old.png' };
    const { upsert } = makeSvc(existing);
    await upsert([baseSku('/uploads/new.png')], null); // erpOrigin unavailable
    expect(existing.imageUrl).toBe('https://erp.example/old.png'); // NOT blanked
  });

  it('updates the image when the sweep resolves a fresh one', async () => {
    const existing = { id: 'itm-1', itemNumber: 'SKU-1', imageUrl: 'https://erp.example/old.png' };
    const { upsert } = makeSvc(existing);
    await upsert([baseSku('/uploads/new.png')], 'https://erp.example');
    expect(existing.imageUrl).toBe('https://erp.example/uploads/new.png');
  });

  it('passes an absolute ERP image URL through unchanged', async () => {
    const existing = { id: 'itm-1', itemNumber: 'SKU-1', imageUrl: null };
    const { upsert } = makeSvc(existing);
    await upsert([baseSku('https://cdn.example/x.png')], 'https://erp.example');
    expect(existing.imageUrl).toBe('https://cdn.example/x.png');
  });
});
