import type { IncreaseLine } from './entities/delivery-increase-request.entity';

/**
 * The unit an increase line is counted in.
 *
 * `item_cart.unit` is NOT it: it is a placeholder that reads "carton" on every
 * item. Quantities and prices are in the item's BASE unit,
 * `item_cart.unit_of_measure` (PCE, KG…), whose names live in `units` by code.
 * "2 carton" on a line that is really two pieces makes the office think it
 * ordered cartons.
 */
export const PRODUCT_UNIT_SQL = `
  SELECT ic.id, ic.item_number, ic.name_ar, ic.name_en,
         ic.unit_of_measure AS unit, u.name_ar AS unit_name_ar, u.name_en AS unit_name_en
    FROM item_cart ic
    LEFT JOIN units u ON u.code = ic.unit_of_measure
   WHERE ic.id = ANY($1::uuid[])`;

export interface ProductUnitRow {
  id: string;
  item_number: string;
  name_ar: string | null;
  name_en: string | null;
  unit: string | null;
  unit_name_ar: string | null;
  unit_name_en: string | null;
}

/** The base unit's code and names; the code stands in for a name the units table does not have. */
export function unitOf(r: Pick<ProductUnitRow, 'unit' | 'unit_name_ar' | 'unit_name_en'>): {
  unit: string | null;
  unitNameAr: string | null;
  unitNameEn: string | null;
} {
  const code = r.unit ?? null;
  return {
    unit: code,
    unitNameAr: r.unit_name_ar ?? code,
    unitNameEn: r.unit_name_en ?? r.unit_name_ar ?? code,
  };
}

/** One increase line from its product row (names and base unit snapshotted). */
export function increaseLineOf(r: ProductUnitRow, qty: number): IncreaseLine {
  return {
    productId: r.id,
    skuCode: r.item_number,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    ...unitOf(r),
    qty,
  };
}

/**
 * Lines stored before the unit was read from the base unit carry the
 * placeholder ("carton") and no unit names. They are corrected at read time
 * from the product; lines that already carry `unitNameAr` are kept as
 * snapshotted. Returns new objects; the stored row is not touched.
 */
export async function withBaseUnits(
  query: (sql: string, params: unknown[]) => Promise<unknown>,
  lines: IncreaseLine[],
): Promise<IncreaseLine[]> {
  const stale = [...new Set(lines.filter((l) => !l.unitNameAr && l.productId).map((l) => l.productId))];
  if (!stale.length) return lines;
  const rows = (await query(PRODUCT_UNIT_SQL, [stale])) as ProductUnitRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return lines.map((l) => {
    const r = l.unitNameAr ? undefined : byId.get(l.productId);
    return r ? { ...l, ...unitOf(r) } : l;
  });
}

/**
 * A count with its noun, the way Arabic agrees them: 1 → "صنف واحد",
 * 2 → "صنفان", 3–10 → "3 أصناف", 11 and up → "11 صنفاً".
 */
export function arabicCount(
  n: number,
  forms: { one: string; two: string; few: string; many: string },
): string {
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  if (n >= 3 && n <= 10) return `${n} ${forms.few}`;
  return `${n} ${forms.many}`;
}

export const ITEMS_AR = { one: 'صنف واحد', two: 'صنفان', few: 'أصناف', many: 'صنفاً' };
export const LINES_AR = { one: 'بند واحد', two: 'بندان', few: 'بنود', many: 'بنداً' };
