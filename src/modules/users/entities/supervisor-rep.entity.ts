import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One row = "this dashboard user supervises this rep".
 *
 * Deliberately not extending BaseEntity: a link row has nothing to update, no
 * version to bump, and must not be soft-deleted — unassigning is a real delete
 * so the (user_id, rep_id) unique constraint stays free for a later re-assign.
 *
 * See docs/SPEC-supervisor-scoping.md §4.
 */
@Entity({ name: 'supervisor_reps' })
@Index('uq_supervisor_rep', ['userId', 'repId'], { unique: true })
export class SupervisorRep {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The supervising dashboard user. */
  @Index('idx_supervisor_reps_user')
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /** The rep whose data the supervisor may see and act on. */
  @Index('idx_supervisor_reps_rep')
  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** Main admin who made the assignment. Null for rows created out-of-band. */
  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null;
}
