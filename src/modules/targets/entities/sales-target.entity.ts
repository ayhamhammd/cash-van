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

  @Column({ type: 'text', default: 'AMOUNT' })
  metric!: TargetMetric;

  /** Target value — fils when metric='AMOUNT', whole units when metric='QTY'. */
  @Column({ name: 'target_value', type: 'bigint' })
  targetValue!: string;

  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
