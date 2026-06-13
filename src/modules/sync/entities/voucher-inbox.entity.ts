import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type InboxType = 'VOUCHER' | 'COLLECTION';
export type InboxStatus = 'pending' | 'posted' | 'failed';

/**
 * Staging row for documents synced from the mobile app. The app POSTs here
 * first (never directly to the main tables), gets back an authoritative number,
 * and the row is then promoted into voucher_headers / collections. Rows that
 * fail promotion (stock, validation…) stay here for review/retry — nothing is
 * ever lost, and client-chosen voucher numbers can never collide with the
 * server sequence.
 */
@Entity({ name: 'voucher_inbox' })
@Index('idx_voucher_inbox_status', ['status', 'createdAt'])
export class VoucherInbox {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  type!: InboxType;

  /** Mobile device's local id — idempotency key so replays don't double-post. */
  @Index('uq_voucher_inbox_client_ref', { unique: true, where: 'client_ref IS NOT NULL' })
  @Column({ name: 'client_ref', type: 'text', nullable: true })
  clientRef?: string | null;

  @Column({ name: 'rep_id', type: 'uuid', nullable: true })
  repId?: string | null;

  @Column({ name: 'user_code', type: 'text', nullable: true })
  userCode?: string | null;

  /** Authoritative voucher number assigned at intake (VOUCHER only). */
  @Column({ name: 'assigned_number', type: 'text', nullable: true })
  assignedNumber?: string | null;

  /** The raw CreateVoucherDto / CreateCollectionDto as sent by the app. */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'text', default: 'pending' })
  status!: InboxStatus;

  /** Created voucher_number / collection id once posted. */
  @Column({ name: 'result_ref', type: 'text', nullable: true })
  resultRef?: string | null;

  @Column({ type: 'text', nullable: true })
  error?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date | null;
}
