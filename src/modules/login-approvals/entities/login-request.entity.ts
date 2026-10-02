import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * pending  → waiting for an administrator
 * approved → an administrator agreed; the browser that asked may now finish
 * rejected → refused
 * expired  → nobody decided in time
 * used     → the approved sign-in was completed (an approval works once)
 */
export type LoginRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'used';

/**
 * A sign-in with a correct password from a browser that is not trusted for
 * that user, waiting for an administrator. Only the browser holding the same
 * device cookie can complete it, so an approval cannot be used from elsewhere.
 */
@Entity({ name: 'login_requests' })
@Index('idx_login_requests_status', ['status', 'createdAt'])
export class LoginRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'device_hash', type: 'text' })
  deviceHash!: string;

  @Column({ type: 'text', nullable: true })
  label?: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent?: string | null;

  @Column({ type: 'text', nullable: true })
  ip?: string | null;

  @Column({ type: 'text', default: 'pending' })
  status!: LoginRequestStatus;

  /** Approved AND trusted: later sign-ins from this browser go straight in. */
  @Column({ type: 'boolean', default: false })
  trust!: boolean;

  @Column({ name: 'decided_by', type: 'uuid', nullable: true })
  decidedBy?: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt?: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
