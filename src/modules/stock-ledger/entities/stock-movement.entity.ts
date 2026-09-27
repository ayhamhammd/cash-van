import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One signed change to one stock pool — the ERP's `stock_movements`, here.
 *
 * READ-ONLY in application code. Rows are written by the database function
 * `stock_apply()`, which the voucher triggers call; nothing in TypeScript may
 * insert, update or delete them (docs/SPEC-single-stock-model.md §3).
 */
@Entity({ name: 'stock_movements' })
export class StockMovement {
  @PrimaryColumn({ type: 'bigint' })
  seq!: string;

  @Column({ name: 'store_number', type: 'text' })
  storeNumber!: string;

  @Column({ name: 'item_number', type: 'text' })
  itemNumber!: string;

  /** The pool: a variant unit's code, or `''` for the item's base pieces. */
  @Column({ name: 'stock_unit_code', type: 'text' })
  stockUnitCode!: string;

  /** Base pieces ×1000, signed: + into the store, − out of it. */
  @Column({ name: 'qty_milli', type: 'bigint' })
  qtyMilli!: string;

  /** The voucher line that caused it. Not a foreign key: the line may be gone. */
  @Column({ name: 'txn_id', type: 'uuid', nullable: true })
  txnId!: string | null;

  @Column({ name: 'voucher_number', type: 'text', nullable: true })
  voucherNumber!: string | null;

  /** post | edit | unpost | delete | backfill */
  @Column({ type: 'text' })
  reason!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
