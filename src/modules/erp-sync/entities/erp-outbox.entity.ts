import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ErpOutboxKind =
  | 'SALE_INVOICE'
  | 'SALES_RETURN'
  | 'SALES_ORDER'
  | 'STOCK_ADJUSTMENT'
  | 'STOCK_TRANSFER'
  | 'PAYMENT'
  // Companion receipt for the PAID portion of a split (part-cash/part-credit)
  // sale — enqueued after the SALE_INVOICE posts, allocated to that invoice.
  | 'SALE_SPLIT_RECEIPT'
  | 'CASH_SETTLEMENT'
  | 'REP_SETTLEMENT_JOURNAL';
export type ErpOutboxStatus = 'pending' | 'posted' | 'failed' | 'dead_letter';

/** Outbound queue: van transactions to push to the ERP (idempotent by `ref`). */
@Entity({ name: 'erp_outbox' })
@Index('idx_erp_outbox_status', ['status'])
export class ErpOutbox {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  kind!: ErpOutboxKind;

  /** The cash-van voucher/collection number — used as the ERP `externalId` + Idempotency-Key. */
  @Index('idx_erp_outbox_ref')
  @Column({ type: 'text' })
  ref!: string;

  @Column({ type: 'text', default: 'pending' })
  status!: ErpOutboxStatus;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt!: Date;

  @Column({ type: 'text', nullable: true })
  error?: string | null;

  /** ERP-assigned id/number returned on success (e.g. the ERP invoice number). */
  @Column({ name: 'result_ref', type: 'text', nullable: true })
  resultRef?: string | null;

  /**
   * ERP general-ledger journal created for this document, when the ERP reports
   * one. NULL on a `posted` SALE_INVOICE means the ERP accepted the invoice but
   * skipped the GL entry — normally because the org has no payment-method
   * account mapped (`PAYMENT_METHOD_ACCOUNT_NOT_CONFIGURED`). That is a setup
   * problem on the ERP side, NOT a failed push: the invoice, its stock movements
   * and the payment record all committed, so this must never be retried.
   */
  @Column({ name: 'journal_id', type: 'text', nullable: true })
  journalId?: string | null;

  /**
   * The ERP declined to record the inline payment (an approval workflow blocked
   * it) and booked the sale as credit instead. The money is NOT in the ERP's
   * books yet even though the van recorded it as collected.
   */
  @Column({ name: 'payment_skipped', type: 'boolean', default: false })
  paymentSkipped!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
