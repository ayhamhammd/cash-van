import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { JoFotaraStatus } from '../../invoices/entities/invoice.entity';

export type LedgerEntryType = 'SALE' | 'RETURN';
export type LedgerDocumentKind = 'INVOICE' | 'CREDIT_NOTE';

@Entity({ name: 'tax_ledger_entries' })
@Index('idx_tle_date_status', ['entryDate', 'jofotaraStatus'])
export class TaxLedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'entry_type', type: 'text' })
  entryType!: LedgerEntryType;

  @Column({ name: 'document_kind', type: 'text' })
  documentKind!: LedgerDocumentKind;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId!: string;

  @Column({ name: 'document_number', type: 'text' })
  documentNumber!: string;

  @Column({ name: 'reference_document_number', type: 'text', nullable: true })
  referenceDocumentNumber?: string | null;

  @Column({ name: 'entry_date', type: 'date' })
  entryDate!: string;

  @Column({ name: 'buyer_name', type: 'text', nullable: true })
  buyerName?: string | null;

  @Column({ name: 'buyer_tin', type: 'text', nullable: true })
  buyerTin?: string | null;

  /** fils; negative for returns */
  @Column({ name: 'taxable_amount', type: 'integer' })
  taxableAmount!: number;

  @Column({ name: 'tax_amount', type: 'integer' })
  taxAmount!: number;

  @Column({ name: 'grand_total', type: 'integer' })
  grandTotal!: number;

  @Column({ name: 'jofotara_status', type: 'text' })
  jofotaraStatus!: JoFotaraStatus;

  @Column({ name: 'qr_code', type: 'text', nullable: true })
  qrCode?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
