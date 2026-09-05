import { ErpSyncService } from './erp-sync.service';

/**
 * Regression: a soft-deleted (pruned) item the ERP still lists must be RESTORED
 * on the next sweep — even when none of its other fields changed.
 *
 * The bug: upsertProductItem set `item.deletedAt = null` in memory, but only
 * called items.save() when itemFingerprint detected a change. The fingerprint
 * does not include deletedAt, so a stable product's restore was computed and then
 * dropped, leaving the item hidden forever (the "7 items missing" on 94). The fix
 * captures `wasDeleted` and forces the write.
 *
 * Single base-unit SKU → the item_units loop is skipped; only items (arg 3) and
 * idmap (arg 17) are touched. Field values below are chosen to MATCH what the
 * sweep computes, so ONLY the deletedAt restore can trigger the write.
 */
function baseSku(sku: string) {
  return {
    id: `erp-${sku}`,
    sku,
    productName: `Widget ${sku}`,
    barcode: null as string | null,
    sellingPrice: 1, // → price 1000 fils
    unitCost: 0.5, // → cost 500 fils
    isActive: true,
    isBaseUnit: true,
    unitMultiplier: 1,
    isTobaccoProduct: false,
    imageUrl: null as string | null,
  };
}

function matchingItem(sku: string, deletedAt: Date | null) {
  return {
    id: `itm-${sku}`,
    itemNumber: sku,
    sku,
    name: `Widget ${sku}`,
    nameAr: `Widget ${sku}`,
    nameEn: `Widget ${sku}`,
    barcode: sku,
    price: 1000,
    cost: 500,
    isActive: true,
    imageUrl: null as string | null,
    isTobaccoProduct: false,
    tobaccoTaxProfileId: null as string | null,
    consumerPriceFils: null as number | null,
    deletedAt,
  };
}

function makeSvc(existing: Record<string, unknown>) {
  const saved: Array<Record<string, unknown>> = [];
  const items = {
    findOne: jest.fn(({ where }: { where: { itemNumber?: string; barcode?: string } }) => {
      if (where.itemNumber !== undefined) return Promise.resolve(existing);
      if (where.barcode !== undefined) return Promise.resolve(null); // barcode free
      return Promise.resolve(null);
    }),
    create: jest.fn((x: Record<string, unknown>) => ({ ...x })),
    save: jest.fn((x: Record<string, unknown>) => {
      saved.push({ ...x });
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

describe('ErpSyncService.upsertProductItem — restore of a pruned item', () => {
  it('re-saves a soft-deleted item and clears deletedAt, even when nothing else changed', async () => {
    const { upsert, saved } = makeSvc(matchingItem('321', new Date('2026-09-04T00:00:00Z')));
    await upsert([baseSku('321')], null);
    expect(saved).toHaveLength(1); // the write happened despite no field diff
    expect(saved[0].deletedAt).toBeNull(); // and the soft-delete was cleared
  });

  it('does NOT write an already-active, unchanged item (no UPDATE storm)', async () => {
    const { upsert, saved } = makeSvc(matchingItem('322', null));
    await upsert([baseSku('322')], null);
    expect(saved).toHaveLength(0); // nothing changed → skip-write still holds
  });
});
