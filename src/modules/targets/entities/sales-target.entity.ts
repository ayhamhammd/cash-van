import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type TargetMetric = 'AMOUNT' | 'QTY';

/**
 * A monthly sales target for one salesman (rep). The target is on either sale
 * AMOUNT (stored in fils, minor units) or sale QTY (whole units), per `metric`.
 * One target per (rep, year, month).
 */
@Entity({ name: 'sales_targets' })
@Index('uq_sales_target_rep_period', ['repId', 'year', 'month'], { unique: true })
export class SalesTarget {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Column({ type: 'integer' })
  year!: number;

  /** 1–12. */
  @Column({ type: 'integer' })
  month!: number;

  /**
   * The OLD single-target shape: AMOUNT or QTY.
   *
   * Superseded by the sales/collection pair below and nullable since. Kept
   * because a QTY target has no equivalent in the new shape and these rows are
   * the only record that it was set.
   */
  @Column({ type: 'text', nullable: true, default: 'AMOUNT' })
  metric?: TargetMetric | null;

  /** Target value — fils when metric='AMOUNT', whole units when metric='QTY'. */
  @Column({ name: 'target_value', type: 'bigint', nullable: true })
  targetValue?: string | null;

  /**
   * What this salesman should SELL this month, in fils. Null = no sales target.
   *
   * Cash and credit share it: a sale is a sale to the person selling it. They
   * are rewarded at different rates below, because the money arrives at
   * different times and carries different risk.
   */
  @Column({ name: 'sales_target_fils', type: 'bigint', nullable: true })
  salesTargetFils?: string | null;

  /** What they should COLLECT this month, in fils. Null = no collection target. */
  @Column({ name: 'collection_target_fils', type: 'bigint', nullable: true })
  collectionTargetFils?: string | null;

  /**
   * Commission rates, as percentages (0–100).
   *
   * Independent of the targets: the rates are what the salesman is PAID, the
   * targets only what they are measured against. Paying commission without
   * setting a target is normal, so neither implies the other.
   *
   * TypeORM hands numerics back as strings — read them through Number().
   */
  @Column({ name: 'cash_pct', type: 'numeric', precision: 5, scale: 2, default: 0 })
  cashPct!: string;

  @Column({ name: 'credit_pct', type: 'numeric', precision: 5, scale: 2, default: 0 })
  creditPct!: string;

  @Column({ name: 'collection_pct', type: 'numeric', precision: 5, scale: 2, default: 0 })
  collectionPct!: string;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
