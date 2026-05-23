import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { InvoiceLine } from './invoice-line.entity';

export type InvoiceStatus =
  | 'draft'
  | 'confirmed'
  | 'pending_approval'
  | 'rejected'
  | 'cancelled';
export type JoFotaraStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'VALIDATED'
  | 'REJECTED'
  | 'ERROR';

@Entity({ name: 'invoices' })
export class Invoice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_invoices_rep_created')
  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Index('idx_invoices_customer')
  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  @Column({ name: 'invoice_number', type: 'text', unique: true })
  invoiceNumber!: string;

  @Index('idx_invoices_status_created')
  @Column({ type: 'text', default: 'draft' })
  status!: InvoiceStatus;

  // ---- totals (fils) ----
  @Column({ type: 'integer', default: 0 })
  subtotal!: number;

  @Column({ name: 'total_line_discounts', type: 'integer', default: 0 })
  totalLineDiscounts!: number;

  @Column({ name: 'invoice_discount_amount', type: 'integer', default: 0 })
  invoiceDiscountAmount!: number;

  @Column({ name: 'net_taxable', type: 'integer', default: 0 })
  netTaxable!: number;

  @Column({ name: 'net_inclusive', type: 'integer', default: 0 })
  netInclusive!: number;

  @Column({ name: 'net_exempt', type: 'integer', default: 0 })
  netExempt!: number;

  @Column({ name: 'tax_on_taxable', type: 'integer', default: 0 })
  taxOnTaxable!: number;

  @Column({ name: 'tax_extracted_from_inclusive', type: 'integer', default: 0 })
  taxExtractedFromInclusive!: number;

  @Column({ name: 'total_tax', type: 'integer', default: 0 })
  totalTax!: number;

  @Column({ name: 'grand_total', type: 'integer', default: 0 })
  grandTotal!: number;

  // ---- JoFotara / ISTD ----
  @Column({ name: 'invoice_type_code', type: 'text', default: '011' })
  invoiceTypeCode!: string;

  @Column({ name: 'payment_method_code', type: 'text', default: '012' })
  paymentMethodCode!: string;

  @Column({ name: 'jofotara_uuid', type: 'uuid', nullable: true })
  jofotaraUuid?: string | null;

  @Column({ name: 'jofotara_status', type: 'text', default: 'PENDING' })
  jofotaraStatus!: JoFotaraStatus;

  @Column({ name: 'jofotara_qr_code', type: 'text', nullable: true })
  jofotaraQrCode?: string | null;

  @Column({ name: 'jofotara_registration_number', type: 'text', nullable: true })
  jofotaraRegistrationNumber?: string | null;

  @Column({ name: 'jofotara_error_code', type: 'text', nullable: true })
  jofotaraErrorCode?: string | null;

  @Column({ name: 'jofotara_error_message', type: 'text', nullable: true })
  jofotaraErrorMessage?: string | null;

  @Column({ name: 'jofotara_submitted_at', type: 'timestamptz', nullable: true })
  jofotaraSubmittedAt?: Date | null;

  @Column({ name: 'has_credit_notes', type: 'boolean', default: false })
  hasCreditNotes!: boolean;

  @Column({ type: 'text', nullable: true })
  note?: string | null;

  @Column({ name: 'device_id', type: 'text', nullable: true })
  deviceId?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt?: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt?: Date | null;

  @OneToMany(() => InvoiceLine, (l) => l.invoice, { cascade: true })
  lines?: InvoiceLine[];
}
