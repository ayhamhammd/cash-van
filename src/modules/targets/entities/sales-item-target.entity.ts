import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type ItemTargetMetric = 'QTY' | 'AMOUNT';

/**
 * A salesman's target for ONE item in one month: a quantity in the item's base
 * unit (QTY) or an amount in fils (AMOUNT). Measured, not paid: commission does
 * not read these in this version.
 */
@Entity({ name: 'sales_item_targets' })
@Index('uq_sales_item_targets_rep_period_item', ['repId', 'year', 'month', 'itemNumber'], { unique: true })
export class SalesItemTarget {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Column({ type: 'integer' })
  year!: number;

  @Column({ type: 'integer' })
  month!: number;

  @Column({ name: 'item_number', type: 'text' })
  itemNumber!: string;

  @Column({ type: 'text' })
  metric!: ItemTargetMetric;

  /** Base units, when metric = QTY. */
  @Column({ name: 'target_qty', type: 'numeric', precision: 14, scale: 3, nullable: true })
  targetQty?: string | null;

  /** Fils, when metric = AMOUNT. */
  @Column({ name: 'target_fils', type: 'bigint', nullable: true })
  targetFils?: string | null;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
