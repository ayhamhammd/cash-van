import { ViewColumn, ViewEntity } from 'typeorm';

/**
 * Read-only stock view materialised by the initial migration.
 * Aggregates net qty by item + warehouse from posted voucher transactions.
 */
@ViewEntity({
  name: 'item_balance',
  expression: `
    SELECT
      ic.item_number               AS item_number,
      ic.item_name                 AS item_name,
      vt.store_number              AS stock_number,
      COALESCE(SUM(vt.signed_qty), 0)::numeric(14,3) AS qty
    FROM item_cart ic
    LEFT JOIN voucher_transactions vt
      ON vt.item_number = ic.item_number
    LEFT JOIN voucher_headers vh
      ON vh.voucher_number = vt.voucher_number
     AND vh.is_posted = TRUE
    GROUP BY ic.item_number, ic.item_name, vt.store_number
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
