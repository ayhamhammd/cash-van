import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type InboxType = 'VOUCHER' | 'COLLECTION';

/**
 * Stored state. `pending`/`failed` are the original vocabulary and are still
 * written and read; `accepted`/`rejected`/`dead_letter` arrive with the drain
 * (docs/SPEC-sync-intake-contract.md §4.3).
 *
 * Distinct from what the HANDSET is told — see `IntakeVerdict`, which is
 * derived. The device needs to know whether to keep its local copy; the row
 * needs to know whether a retry is due. Those are different questions.
 */
export type InboxStatus =
  | 'pending'
  | 'posted'
  | 'failed'
  | 'accepted'
  | 'rejected'
  | 'dead_letter';

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

  /**
   * Mobile device's local id — the idempotency key.
   *
   * NOT NULL and TOTALLY unique, because the intake claims it with
   * `ON CONFLICT (client_ref) DO NOTHING`: a partial index only arbitrates rows
   * matching its predicate, so it cannot serve as the conflict target. A request
   * that arrives without one is given a synthetic `auto:<uuid>` and logged —
   * such a document cannot be deduped, which is the point of the warning.
   */
  @Index('uq_voucher_inbox_client_ref', { unique: true })
  @Column({ name: 'client_ref', type: 'text' })
  clientRef!: string;

  @Column({ name: 'rep_id', type: 'uuid', nullable: true })
  repId?: string | null;

  @Column({ name: 'user_code', type: 'text', nullable: true })
  userCode?: string | null;

  /** Authoritative voucher number assigned at intake (VOUCHER only). */
  @Column({ name: 'assigned_number', type: 'text', nullable: true })
  assignedNumber?: string | null;

  /**
   * The number the APP minted, kept even when the server assigns a different
   * one, so the rep's handset and the office's dashboard can still be matched
   * up by hand.
   */
  @Column({ name: 'client_number', type: 'text', nullable: true })
  clientNumber?: string | null;

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

  // ---- Retry state, mirroring erp_outbox so the two queues behave alike -----

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt!: Date;

  @Column({ name: 'last_attempt_at', type: 'timestamptz', nullable: true })
  lastAttemptAt?: Date | null;
}
