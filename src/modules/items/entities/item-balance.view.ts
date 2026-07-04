import { ViewColumn, ViewEntity } from 'typeorm';

/**
 * Read-only per-stock balance view.
 *
 * Each posted voucher line moves qty between stocks:
 *   - from_store_number loses qty (outflow)  → SALE, the OUT side of a TRANSFER
 *   - to_store_number   gains qty (inflow)   → RETURN, the IN side of a TRANSFER
 * A TRANSFER line sets both, so a single posted voucher decrements the source
 * stock and increments the destination stock. Only posted vouchers count.
 */
@ViewEntity({
  name: 'item_balance',
  expression: `
    SELECT
      ic.item_number               AS item_number,
      ic.item_name                 AS item_name,
      m.store_number               AS stock_number,
      COALESCE(SUM(m.delta), 0)::numeric(14,3) AS qty
    FROM item_cart ic
    LEFT JOIN (
      SELECT vt.item_number,
             vt.from_store_number AS store_number,
             -vt.item_qty         AS delta
      FROM voucher_transactions vt
      JOIN voucher_headers vh
        ON vh.voucher_number = vt.voucher_number
       AND vh.is_posted = TRUE
      WHERE vt.from_store_number IS NOT NULL
      UNION ALL
      SELECT vt.item_number,
             vt.to_store_number AS store_number,
             vt.item_qty        AS delta
      FROM voucher_transactions vt
      JOIN voucher_headers vh
        ON vh.voucher_number = vt.voucher_number
       AND vh.is_posted = TRUE
      WHERE vt.to_store_number IS NOT NULL
    ) m ON m.item_number = ic.item_number
    GROUP BY ic.item_number, ic.item_name, m.store_number
  `,
})
export class ItemBalanceView {
  @ViewColumn({ name: 'item_number' })
  itemNumber!: string;

  @ViewColumn({ name: 'item_name' })
  itemName!: string;

  @ViewColumn({ name: 'stock_number' })
  stockNumber!: string | null;

  @ViewColumn()
  qty!: string;
}
