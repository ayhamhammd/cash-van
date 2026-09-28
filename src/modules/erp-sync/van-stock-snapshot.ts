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
