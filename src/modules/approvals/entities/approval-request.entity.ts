import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type ApprovalType =
  | 'RETURN_VOUCHER'
  | 'VOUCHER_DISCOUNT'
  | 'PRICE_OVERRIDE';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/**
 * A salesman's request to perform a gated action (return / discount / price
 * override). `payload` holds the full proposed CreateVoucherDto; on approval
 * the backend executes it verbatim and records the resulting voucher number.
 */
@Entity({ name: 'approval_requests' })
@Index('idx_approval_requests_status', ['status', 'createdAt'])
@Index('idx_approval_requests_requester', ['requesterUser', 'createdAt'])
export class ApprovalRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  type!: ApprovalType;

  @Column({ type: 'text', default: 'pending' })
  status!: ApprovalStatus;

  /** users.id of the salesman who asked. */
  @Column({ name: 'requester_user', type: 'uuid' })
  requesterUser!: string;

  @Column({ name: 'rep_id', type: 'uuid', nullable: true })
  repId?: string | null;

  @Column({ name: 'customer_number', type: 'text', nullable: true })
  customerNumber?: string | null;

  /** The proposed CreateVoucherDto (+ any context the client wants echoed back). */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** Salesman's justification. */
  @Column({ type: 'text', nullable: true })
  note?: string | null;

  @Column({ name: 'reviewer_user', type: 'uuid', nullable: true })
  reviewerUser?: string | null;

  @Column({ name: 'decision_note', type: 'text', nullable: true })
  decisionNote?: string | null;

  /** voucher_number created when an approval was executed. */
  @Column({ name: 'result_voucher', type: 'text', nullable: true })
  resultVoucher?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt?: Date | null;
}
