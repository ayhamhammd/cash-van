import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CreditNoteLine } from './credit-note-line.entity';
import type { JoFotaraStatus } from '../../invoices/entities/invoice.entity';

@Entity({ name: 'credit_notes' })
export class CreditNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'credit_note_number', type: 'text', unique: true })
  creditNoteNumber!: string;

  @Index('idx_credit_notes_original')
  @Column({ name: 'original_invoice_id', type: 'uuid' })
  originalInvoiceId!: string;

  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'integer', default: 0 })
  subtotal!: number;

  @Column({ name: 'total_line_discounts', type: 'integer', default: 0 })
  totalLineDiscounts!: number;

  @Column({ name: 'net_after_line_discounts', type: 'integer', default: 0 })
  netAfterLineDiscounts!: number;

  @Column({ name: 'total_return_tax', type: 'integer', default: 0 })
  totalReturnTax!: number;

  @Column({ name: 'grand_return_total', type: 'integer', default: 0 })
  grandReturnTotal!: number;

  @Column({ name: 'invoice_type_code', type: 'text', default: '381' })
  invoiceTypeCode!: string;

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

  @Column({ name: 'issued_at', type: 'timestamptz', default: () => 'now()' })
  issuedAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null;

  @OneToMany(() => CreditNoteLine, (l) => l.creditNote, { cascade: true })
  lines?: CreditNoteLine[];
}
