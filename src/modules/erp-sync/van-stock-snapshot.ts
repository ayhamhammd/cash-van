/**
 * The ERP holds one stock row per SKU per warehouse. A snapshot that carries the
 * same pair twice was paged on an unstable sort (ERP before 3c9d489): some rows
 * came back twice and others never came back, so every total built from it is
 * wrong - doubled in one store, zero in another. Such a snapshot is refused,
 * never corrected against.
 */
export type SnapshotRowKey = {
  skuId?: string | null;
  skuCode: string;
  warehouseId?: string | null;
  warehouseName: string;
};

/** How many rows repeat a SKU + warehouse pair already seen (0 = a sound snapshot). */
export function repeatedStockRows(rows: readonly SnapshotRowKey[]): number {
  const seen = new Set<string>();
  let repeated = 0;
  for (const r of rows) {
    const key = `${r.warehouseId || r.warehouseName}|${r.skuId || r.skuCode}`;
    if (seen.has(key)) repeated += 1;
    else seen.add(key);
  }
  return repeated;
}

export const UNSTABLE_SNAPSHOT_MESSAGE =
  'The ERP sent the same stock row more than once, so its stock list is missing other rows. ' +
  'Nothing was compared or corrected. Update the ERP (the /van/stock sort fix) and try again.';

type Store = { whNumber: string; whName: string | null };
type ResolvedStore = { number: string; name: string };

/**
 * Which cash-van store an ERP stock row belongs to. By the ERP warehouse id
 * first (erp_id_map, written by the warehouse pull), and by name only when no
 * other store shares that name. Matching by name alone let two stores called
 * the same thing (77: vans 11 and 99) swap stock: the ERP's van 11 read as
 * store 99, van 11 read as holding nothing, and Match ERP emptied it.
 */
export function buildStoreResolver(
  stores: readonly Store[],
  warehouseIdMap: readonly { erpId: string; localId: string | null }[],
): (row: { warehouseId?: string | null; warehouseName?: string | null }) => ResolvedStore | undefined {
  const byNumber = new Map<string, ResolvedStore>();
  const nameCount = new Map<string, number>();
  for (const s of stores) {
    byNumber.set(s.whNumber, { number: s.whNumber, name: s.whName ?? s.whNumber });
    const n = s.whName?.trim();
    if (n) nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  }
  const byUniqueName = new Map<string, ResolvedStore>();
  for (const s of stores) {
    const n = s.whName?.trim();
    if (n && nameCount.get(n) === 1) byUniqueName.set(n, byNumber.get(s.whNumber)!);
  }
  const byErpId = new Map<string, ResolvedStore>();
  for (const m of warehouseIdMap) {
    const store = m.localId ? byNumber.get(m.localId) : undefined;
    if (store) byErpId.set(String(m.erpId), store);
  }
  return (row) => {
    if (row.warehouseId) {
      const byId = byErpId.get(String(row.warehouseId));
      if (byId) return byId;
    }
    const n = row.warehouseName?.trim();
    return n ? byUniqueName.get(n) : undefined;
  };
}
