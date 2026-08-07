import { ViewColumn, ViewEntity } from 'typeorm';

/**
 * Per-item roll-up of `item_balance`: all variant pools of one item folded back
 * together, one row per (item, store).
 *
 * This is the shape `item_balance` had before stock gained a unit dimension, and
 * it exists so a caller that legitimately means "the whole item, all colours" —
 * a low-stock alert, a valuation total — does not have to know the grain or
 * re-derive the sum itself.
 */
@ViewEntity({
  name: 'item_balance_total',
  expression: `
    SELECT
      item_number,
      item_name,
      stock_number,
      SUM(qty)::numeric(14,3) AS qty
    FROM item_balance
    GROUP BY item_number, item_name, stock_number
  `,
})
export class ItemBalanceTotalView {
  @ViewColumn({ name: 'item_number' })
  itemNumber!: string;

  @ViewColumn({ name: 'item_name' })
  itemName!: string;

  @ViewColumn({ name: 'stock_number' })
  stockNumber!: string | null;

  @ViewColumn()
  qty!: string;
}
