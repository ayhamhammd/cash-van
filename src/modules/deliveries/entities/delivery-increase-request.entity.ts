import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type IncreaseStatus = 'PENDING' | 'ORDERED' | 'DISMISSED';

/** One requested line, with the product's name and unit snapshotted when it was asked for. */
export interface IncreaseLine {
  productId: string;
  skuCode: string;
  nameAr: string | null;
  nameEn: string | null;
  unit: string | null;
  qty: number;
}

/**
 * The customer wanted more than the invoice (phase-4 contract §B). Recorded with
 * the stop's result; the office turns it into an ORDER voucher or dismisses it.
 */
@Entity({ name: 'delivery_increase_requests' })
@Index('uq_delivery_increase_requests_client_ref', ['clientRef'], { unique: true })
export class DeliveryIncreaseRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The result's clientRef. */
  @Column({ name: 'client_ref', type: 'text' })
  clientRef!: string;

  @Column({ name: 'stop_id', type: 'uuid', nullable: true })
  stopId?: string | null;

  @Column({ name: 'run_id', type: 'uuid', nullable: true })
  runId?: string | null;

  @Column({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId?: string | null;

  /** The delivery rep who recorded it. */
  @Column({ name: 'rep_id', type: 'uuid', nullable: true })
  repId?: string | null;

  /** Snapshotted, so the request still names its invoice if the stop leaves the mirror. */
  @Column({ name: 'invoice_number', type: 'text', nullable: true })
  invoiceNumber?: string | null;

  @Column({ type: 'jsonb' })
  lines!: IncreaseLine[];

  @Column({ type: 'text', default: 'PENDING' })
  status!: IncreaseStatus;

  /** The ORDER voucher's id, for the dashboard's /operations/[id] link. */
  @Column({ name: 'order_voucher_id', type: 'uuid', nullable: true })
  orderVoucherId?: string | null;

  @Column({ name: 'order_voucher_number', type: 'text', nullable: true })
  orderVoucherNumber?: string | null;

  @Column({ name: 'order_total_fils', type: 'bigint', nullable: true })
  orderTotalFils?: string | null;

  @Column({ name: 'decided_by', type: 'text', nullable: true })
  decidedBy?: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt?: Date | null;

  @Column({ name: 'decision_note', type: 'text', nullable: true })
  decisionNote?: string | null;

  /** The dashboard's Idempotency-Key for the decision. */
  @Column({ name: 'decision_key', type: 'text', nullable: true })
  decisionKey?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
