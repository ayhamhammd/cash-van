import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * What a store holds of one pool — the ERP's `item_stock`, here. Always the sum
 * of that pool's [StockMovement]s.
 *
 * READ-ONLY in application code, like the movements: `stock_apply()` changes it
 * in the same transaction as the movement it records. Readers mostly go through
 * the `item_balance` view, which is defined over this table.
 */
@Entity({ name: 'stock_balance' })
export class StockBalance {
  @PrimaryColumn({ name: 'store_number', type: 'text' })
  storeNumber!: string;

  @PrimaryColumn({ name: 'item_number', type: 'text' })
  itemNumber!: string;

  @PrimaryColumn({ name: 'stock_unit_code', type: 'text' })
  stockUnitCode!: string;

  /** Base pieces ×1000. */
  @Column({ name: 'qty_milli', type: 'bigint' })
  qtyMilli!: string;

  /** The seq of the last movement applied to this pool. */
  @Column({ name: 'last_seq', type: 'bigint' })
  lastSeq!: string;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
