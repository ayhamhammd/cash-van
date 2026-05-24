import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One recurring visit rule: rep serves this outlet on these weekdays.
 * weekdays use 0=Sunday .. 6=Saturday.
 */
@Entity({ name: 'journey_plan_entries' })
@Index('uq_journey_plan_rep_customer', ['repId', 'customerId'], { unique: true })
@Index('idx_journey_plan_rep_active', ['repId', 'isActive'])
export class JourneyPlanEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  /** Days the outlet is visited. 0=Sunday .. 6=Saturday. */
  @Column({ type: 'smallint', array: true })
  weekdays!: number[];

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
