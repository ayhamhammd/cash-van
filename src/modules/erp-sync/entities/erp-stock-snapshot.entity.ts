import { Column, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * Last-known ERP on-hand quantity per (store, ERP SKU code), from `GET
 * /api/v1/van/stock`. `pullVanStock` diffs each poll against this baseline to
 * compute a net delta — van/stock is a snapshot, not an event ledger, so this
 * table IS the cursor (there's no `since` timestamp to page from).
 */
@Entity({ name: 'erp_stock_snapshot' })
@Unique('uq_erp_stock_snapshot_store_sku', ['store', 'skuCode'])
export class ErpStockSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** cash-van store code (Warehouse.whNumber). */
  @Column({ type: 'text' })
  store!: string;

  /** ERP SKU code (van/stock's `skuCode`). */
  @Column({ name: 'sku_code', type: 'text' })
  skuCode!: string;

  /** Last quantity observed on the ERP for this (store, sku). */
  @Column({ type: 'integer' })
  quantity!: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
