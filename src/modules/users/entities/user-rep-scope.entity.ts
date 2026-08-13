import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One salesman a scoped dashboard user is allowed to see.
 *
 * Only meaningful when the user's `repScopeMode` is `'assigned'` — see
 * docs/SPEC-rep-scoped-users.md. Rows are ignored entirely for `'all'` users,
 * so leaving stale rows behind when someone is promoted is harmless.
 */
@Entity({ name: 'user_rep_scope' })
@Index('uq_user_rep_scope', ['userId', 'repId'], { unique: true })
@Index('idx_user_rep_scope_user', ['userId'])
export class UserRepScope {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
