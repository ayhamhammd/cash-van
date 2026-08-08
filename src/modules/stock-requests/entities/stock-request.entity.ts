import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { StockRequestItem } from './stock-request-item.entity';

/**
 * pending    — the salesman submitted it; managers see it in the queue
 * approved   — a manager approved it; an ERP transfer is queued for the warehouse
 * rejected   — a manager refused it
 * cancelled  — the requester withdrew it while still pending
 * received   — the salesman confirmed the goods reached the van; van stock moved
 *
 * There is deliberately no `dispatched` state here. Dispatch happens in the ERP,
 * on the ERP's own transfer, and the cash van learns about it only when the
 * salesman physically has the goods. Mirroring a state we cannot observe would
 * mean showing a status that could be wrong.
 */
export type StockRequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'received';

/**
 * A salesman asking for stock to be loaded onto their van.
 *
 * Modelled separately from `approval_requests` rather than as another type on
 * it. That table's contract is "a payload that is executed verbatim on
 * approval", and its status set ends at the decision. A stock request survives
 * its approval — it still has to be dispatched and received — and a manager may
 * approve a different quantity than was asked for, which needs a per-line home.
 */
@Entity({ name: 'stock_requests' })
@Index('idx_stock_requests_status', ['status', 'createdAt'])
@Index('idx_stock_requests_rep', ['repId', 'createdAt'])
export class StockRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Human-facing sequential number, e.g. SR-000042. */
  @Index('idx_stock_requests_number', { unique: true })
  @Column({ name: 'request_number', type: 'text' })
  requestNumber!: string;

  @Column({ type: 'text', default: 'pending' })
  status!: StockRequestStatus;

  /** users.id of the salesman who asked. */
  @Column({ name: 'requester_user', type: 'uuid' })
  requesterUser!: string;

  @Column({ name: 'rep_id', type: 'uuid', nullable: true })
  repId?: string | null;

  /** Destination: the rep's own van store (warehouses.wh_number). */
  @Column({ name: 'van_store_number', type: 'text' })
  vanStoreNumber!: string;

  /**
   * Source warehouse the goods come from. Chosen by the manager at approval
   * time, not by the salesman — the salesman rarely knows which warehouse can
   * actually fill the order.
   */
  @Column({ name: 'source_store_number', type: 'text', nullable: true })
  sourceStoreNumber?: string | null;

  /** Salesman's justification ("running out of the 1L before Thursday"). */
  @Column({ type: 'text', nullable: true })
  note?: string | null;

  @Column({ name: 'reviewer_user', type: 'uuid', nullable: true })
  reviewerUser?: string | null;

  @Column({ name: 'decision_note', type: 'text', nullable: true })
  decisionNote?: string | null;

  /**
   * The cash-van TRANSFER voucher raised when the salesman confirmed receipt.
   * Null until then — this is what moved the stock locally.
   */
  @Column({ name: 'transfer_voucher_number', type: 'text', nullable: true })
  transferVoucherNumber?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt?: Date | null;

  @Column({ name: 'received_at', type: 'timestamptz', nullable: true })
  receivedAt?: Date | null;

  @OneToMany(() => StockRequestItem, (i) => i.request, { cascade: true })
  items!: StockRequestItem[];
}
