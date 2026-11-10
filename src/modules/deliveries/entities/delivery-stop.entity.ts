import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type DeliveryStopStatus = 'LOADED' | 'DELIVERED' | 'PARTIAL' | 'RETURNED';
export type DeliveryReturnStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';
export type DeliveryOutcome = 'DELIVERED' | 'PARTIAL' | 'RETURNED';

/**
 * Mirror of one invoice on an ERP run (ERP `delivery_run_items`).
 *
 * The ERP columns are written only by the pull. The local_* columns hold the
 * phone's result while it is on its way to the ERP: `local_result_ref` is the
 * phone's clientRef, set at intake and cleared once the ERP has answered. While
 * it is set the stop shows as SENDING and the pull never deletes it — a delivery
 * that really happened must not vanish because the office edited the run.
 *
 * Money is fils.
 */
@Entity({ name: 'delivery_stops' })
@Index('uq_delivery_stops_erp_id', ['erpId'], { unique: true })
@Index('idx_delivery_stops_run', ['runId', 'sequence'])
export class DeliveryStop {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'erp_id', type: 'text' })
  erpId!: string;

  @Column({ name: 'run_id', type: 'uuid' })
  runId!: string;

  @Column({ type: 'integer', default: 0 })
  sequence!: number;

  @Column({ name: 'erp_invoice_id', type: 'text', nullable: true })
  erpInvoiceId?: string | null;

  @Column({ name: 'invoice_number', type: 'text', nullable: true })
  invoiceNumber?: string | null;

  @Column({ name: 'invoice_date', type: 'timestamptz', nullable: true })
  invoiceDate?: Date | null;

  @Column({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId?: string | null;

  @Column({ name: 'erp_customer_id', type: 'text', nullable: true })
  erpCustomerId?: string | null;

  @Column({ name: 'customer_code', type: 'text', nullable: true })
  customerCode?: string | null;

  @Column({ name: 'recipient_name', type: 'text', nullable: true })
  recipientName?: string | null;

  @Column({ name: 'recipient_phone', type: 'text', nullable: true })
  recipientPhone?: string | null;

  @Column({ type: 'text', nullable: true })
  address?: string | null;

  @Column({ name: 'total_fils', type: 'bigint', default: 0 })
  totalFils!: string;

  @Column({ name: 'tax_fils', type: 'bigint', default: 0 })
  taxFils!: string;

  @Column({ name: 'paid_fils', type: 'bigint', default: 0 })
  paidFils!: string;

  @Column({ name: 'payment_type', type: 'text', nullable: true })
  paymentType?: string | null;

  @Column({ name: 'jofotara_status', type: 'text', nullable: true })
  jofotaraStatus?: string | null;

  @Column({ name: 'jofotara_qr', type: 'text', nullable: true })
  jofotaraQr?: string | null;

  @Column({ name: 'jofotara_uuid', type: 'text', nullable: true })
  jofotaraUuid?: string | null;

  @Column({ type: 'text', default: 'LOADED' })
  status!: DeliveryStopStatus;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt?: Date | null;

  @Column({ name: 'signed_by_name', type: 'text', nullable: true })
  signedByName?: string | null;

  @Column({ type: 'numeric', nullable: true })
  lat?: string | null;

  @Column({ type: 'numeric', nullable: true })
  lng?: string | null;

  /** ERP | CASHVAN — who recorded the result on the ERP. */
  @Column({ name: 'result_source', type: 'text', nullable: true })
  resultSource?: string | null;

  /** The externalId the result was recorded under (a phone clientRef when CASHVAN). */
  @Column({ name: 'result_external_ref', type: 'text', nullable: true })
  resultExternalRef?: string | null;

  @Column({ name: 'return_status', type: 'text', default: 'NONE' })
  returnStatus!: DeliveryReturnStatus;

  @Column({ name: 'return_decision_note', type: 'text', nullable: true })
  returnDecisionNote?: string | null;

  @Column({ name: 'credit_note_number', type: 'text', nullable: true })
  creditNoteNumber?: string | null;

  @Column({ name: 'credit_note_qr', type: 'text', nullable: true })
  creditNoteQr?: string | null;

  @Column({ name: 'credit_note_total_fils', type: 'bigint', nullable: true })
  creditNoteTotalFils?: string | null;

  /** When the ERP decided the return (approve or reject). */
  @Column({ name: 'return_decided_at', type: 'timestamptz', nullable: true })
  returnDecidedAt?: Date | null;

  /** Who decided it, as the ERP recorded them (a name). */
  @Column({ name: 'return_decided_by', type: 'text', nullable: true })
  returnDecidedBy?: string | null;

  @Column({ name: 'credit_note_erp_id', type: 'text', nullable: true })
  creditNoteErpId?: string | null;

  @Column({ name: 'credit_note_tax_fils', type: 'bigint', nullable: true })
  creditNoteTaxFils?: string | null;

  @Column({ name: 'credit_note_jofotara_status', type: 'text', nullable: true })
  creditNoteJofotaraStatus?: string | null;

  @Column({ name: 'credit_note_uuid', type: 'text', nullable: true })
  creditNoteUuid?: string | null;

  /** The CashVan RETURN voucher the approved return became (`ERP-RET-<credit note>`). */
  @Column({ name: 'return_voucher_number', type: 'text', nullable: true })
  returnVoucherNumber?: string | null;

  @Column({ name: 'return_voucher_id', type: 'uuid', nullable: true })
  returnVoucherId?: string | null;

  /** ERP attachments on the item that are not one of our proofs (counted, not mirrored). */
  @Column({ name: 'erp_only_attachments', type: 'integer', default: 0 })
  erpOnlyAttachments!: number;

  // ---- the phone's result while it is in flight ------------------------------

  @Column({ name: 'local_result_ref', type: 'text', nullable: true })
  localResultRef?: string | null;

  @Column({ name: 'local_outcome', type: 'text', nullable: true })
  localOutcome?: DeliveryOutcome | null;

  @Column({ name: 'local_delivered_at', type: 'timestamptz', nullable: true })
  localDeliveredAt?: Date | null;

  @Column({ name: 'local_signed_by', type: 'text', nullable: true })
  localSignedBy?: string | null;

  @Column({ name: 'local_lat', type: 'numeric', nullable: true })
  localLat?: string | null;

  @Column({ name: 'local_lng', type: 'numeric', nullable: true })
  localLng?: string | null;

  @Column({ name: 'local_note', type: 'text', nullable: true })
  localNote?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
