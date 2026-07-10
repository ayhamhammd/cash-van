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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
