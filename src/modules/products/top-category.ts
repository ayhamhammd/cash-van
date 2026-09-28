/**
 * The first-level category a category sits under: walk its parents to the top.
 *
 * The ERP nests categories in levels, and a product carries its deepest one.
 * The van app filters on the first level, so every product is placed under the
 * root of its own branch. A cycle or a parent that is missing locally stops the
 * walk at the last category reached rather than looping or losing the product.
 */
export function topCategoryOf(
  id: string | null | undefined,
  parentById: ReadonlyMap<string, string | null | undefined>,
): string | null {
  if (!id) return null;
  let current = id;
  const seen = new Set<string>([current]);
  for (;;) {
    const parent = parentById.get(current);
    if (!parent || !parentById.has(parent) || seen.has(parent)) return current;
    seen.add(parent);
    current = parent;
  }
}
