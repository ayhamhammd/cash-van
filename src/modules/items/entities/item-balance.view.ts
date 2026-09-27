import { ViewColumn, ViewEntity } from 'typeorm';

/**
 * Read-only per-stock balance, one row per (item, stock unit, store).
 *
 * Since StockLedger1727800000000 this reads the STORED balance (`stock_balance`),
 * which the voucher triggers keep equal to what this view used to compute by
 * summing every posted line: from_store_number loses `item_qty`, to_store_number
 * gains it, drafts count for nothing (docs/SPEC-single-stock-model.md). Same
 * columns as before, so every reader moved over without a change. The old
 * summing definition survives as `item_balance_replay`, for verification only.
 *
 * `stock_unit_code` is the pool: `''` is the item's base pieces (where every
 * packaging unit converts to), anything else is a variant that owns its stock.
 * Callers that mean "the whole item regardless of variant" read
 * `item_balance_total` instead of re-summing this.
 */
@ViewEntity({
  name: 'item_balance',
  expression: `
    SELECT
      ic.item_number                                                  AS item_number,
      ic.item_name                                                    AS item_name,
      b.store_number                                                  AS stock_number,
      COALESCE(b.stock_unit_code, '')                                 AS stock_unit_code,
      (COALESCE(SUM(b.qty_milli), 0)::numeric / 1000)::numeric(14,3)  AS qty
    FROM item_cart ic
    LEFT JOIN stock_balance b ON b.item_number = ic.item_number
    GROUP BY ic.item_number, ic.item_name, b.store_number, COALESCE(b.stock_unit_code, '')
  `,
})
export class ItemBalanceView {
  @ViewColumn({ name: 'item_number' })
  itemNumber!: string;

  @ViewColumn({ name: 'item_name' })
  itemName!: string;

  @ViewColumn({ name: 'stock_number' })
  stockNumber!: string | null;

  /** The pool: a variant unit's code, or `''` for the item's base pieces. */
  @ViewColumn({ name: 'stock_unit_code' })
  stockUnitCode!: string;

  @ViewColumn()
  qty!: string;
}
