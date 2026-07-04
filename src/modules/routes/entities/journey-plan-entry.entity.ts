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

  /** Admin note shown to the salesman for this outlet's trip (read-only on mobile). */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  /** Task the salesman must complete when visiting this outlet. */
  @Column({ type: 'text', nullable: true })
  todo!: string | null;

  /** Manual visit order within a day (ascending). */
  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder!: number;

  /** Date the salesman last marked the to-do done (resets the badge each day). */
  @Column({ name: 'todo_done_date', type: 'date', nullable: true })
  todoDoneDate!: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
