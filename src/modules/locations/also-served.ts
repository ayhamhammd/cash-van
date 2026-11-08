/**
 * Who ALSO serves a shop besides its main salesman (docs/SPEC-location-tree.md
 * §5.6). Read through the shop's place every time it is asked, never stored on
 * the customer, so a change to a place reaches every shop under it at once.
 *
 *   - chosen for the shop itself: customer_extra_reps (any mode);
 *   - given to its area or any place above it: location_extra_reps (TREE only).
 *
 * The main salesman is never "also" his own shop's; an inactive or deleted
 * salesman serves nobody.
 */

/** Places only count in TREE mode (Q2: salesmen by area are a tree feature). */
const TREE_MODE = `EXISTS (SELECT 1 FROM app_settings st WHERE st.id = 1 AND st.location_mode = 'TREE')`;

/**
 * SQL: does the salesman in `repParam` also serve the customer aliased `c`?
 * For the phone's own list, so the caller is that salesman himself.
 */
export function alsoServedByRepSql(repParam: string): string {
  const direct = `EXISTS (SELECT 1 FROM customer_extra_reps xr
                           WHERE xr.customer_id = c.id AND xr.rep_id = ${repParam})`;
  const byPlace = `EXISTS (SELECT 1 FROM locations sl
                             JOIN locations sa ON sl.path LIKE sa.path || '%' AND sa.deleted_at IS NULL
                             JOIN location_extra_reps lr ON lr.location_id = sa.id AND lr.rep_id = ${repParam}
                            WHERE sl.id = c.location_id AND sl.deleted_at IS NULL
                              AND ${TREE_MODE})`;
  return `(${direct} OR ${byPlace})`;
}

export interface AlsoServedRep {
  repId: string;
  repName: string;
  /** DIRECT: chosen for this shop. AREA: given to its area or a place above. */
  source: 'DIRECT' | 'AREA';
  /** For AREA: the place it comes from. */
  locationId: string | null;
}

/**
 * Everyone who also serves each of `customerIds`, by customer. One query for
 * a whole page of customers.
 */
export const ALSO_SERVED_BY_CUSTOMERS_SQL = `
  WITH cs AS (
    SELECT c.id, c.rep_id, c.location_id FROM customers c WHERE c.id = ANY($1::uuid[])
  ),
  pairs AS (
    SELECT cs.id AS customer_id, xr.rep_id, 'DIRECT' AS source, NULL::uuid AS location_id, 0 AS depth
      FROM cs JOIN customer_extra_reps xr ON xr.customer_id = cs.id
    UNION ALL
    SELECT cs.id, lr.rep_id, 'AREA', sa.id, sa.depth
      FROM cs
      JOIN locations sl ON sl.id = cs.location_id AND sl.deleted_at IS NULL
      JOIN locations sa ON sl.path LIKE sa.path || '%' AND sa.deleted_at IS NULL
      JOIN location_extra_reps lr ON lr.location_id = sa.id
     WHERE ${TREE_MODE}
  )
  SELECT DISTINCT ON (p.customer_id, p.rep_id)
         p.customer_id, p.rep_id, p.source, p.location_id,
         CASE WHEN r.code IS NOT NULL THEN r.name_ar || ' (' || r.code || ')' ELSE r.name_ar END AS rep_name
    FROM pairs p
    JOIN cs ON cs.id = p.customer_id
    JOIN reps r ON r.id = p.rep_id AND r.is_active AND r.deleted_at IS NULL
   WHERE p.rep_id IS DISTINCT FROM cs.rep_id
   ORDER BY p.customer_id, p.rep_id, (p.source = 'DIRECT') DESC, p.depth DESC`;
