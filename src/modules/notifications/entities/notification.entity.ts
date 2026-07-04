import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One inbox item per recipient. Manager "broadcasts" are fanned out at insert
 * time (one row per manager/admin) so read state stays per-user and queries
 * stay trivial. `userId` is the recipient's users.id.
 */
@Entity({ name: 'notifications' })
@Index('idx_notifications_user', ['userId', 'readAt', 'createdAt'])
export class AppNotification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Recipient users.id. */
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /** e.g. approval.requested | approval.decided | cheque.due | visit.unverified */
  @Column({ type: 'text' })
  kind!: string;

  @Column({ name: 'title_ar', type: 'text' })
  titleAr!: string;

  @Column({ name: 'title_en', type: 'text' })
  titleEn!: string;

  @Column({ name: 'body_ar', type: 'text', nullable: true })
  bodyAr?: string | null;

  @Column({ name: 'body_en', type: 'text', nullable: true })
  bodyEn?: string | null;

  /** Linked record: approval | cheque | visit | trip | voucher */
  @Column({ name: 'ref_type', type: 'text', nullable: true })
  refType?: string | null;

  @Column({ name: 'ref_id', type: 'text', nullable: true })
  refId?: string | null;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
