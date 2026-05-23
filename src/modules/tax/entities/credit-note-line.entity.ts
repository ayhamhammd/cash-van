import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CreditNote } from './credit-note.entity';
import type { TaxCategory, TaxType } from '../../items/entities/item-cart.entity';

@Entity({ name: 'credit_note_lines' })
export class CreditNoteLine {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_cnl_credit_note')
  @Column({ name: 'credit_note_id', type: 'uuid' })
  creditNoteId!: string;

  @ManyToOne(() => CreditNote, (c) => c.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'credit_note_id' })
  creditNote?: CreditNote;

  @Index('idx_cnl_invoice_line')
  @Column({ name: 'invoice_line_id', type: 'bigint', nullable: true })
  invoiceLineId?: string | null;

  @Column({ name: 'product_id', type: 'uuid' })
  productId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 3 })
  quantity!: string;

  @Column({ name: 'unit_price', type: 'integer' })
  unitPrice!: number;

  @Column({ name: 'unit_of_measure', type: 'text', default: 'PCE' })
  unitOfMeasure!: string;

  @Column({ name: 'tax_type', type: 'text' })
  taxType!: TaxType;

  @Column({ name: 'tax_category', type: 'text' })
  taxCategory!: TaxCategory;

  @Column({ name: 'tax_rate', type: 'numeric', precision: 5, scale: 4 })
  taxRate!: string;

  @Column({ type: 'integer' })
  subtotal!: number;

  @Column({ name: 'line_discount_amount', type: 'integer', default: 0 })
  lineDiscountAmount!: number;

  @Column({ name: 'net_after_line_discount', type: 'integer' })
  netAfterLineDiscount!: number;

  @Column({ name: 'taxable_base', type: 'integer' })
  taxableBase!: number;

  @Column({ name: 'tax_amount', type: 'integer' })
  taxAmount!: number;

  @Column({ name: 'line_total', type: 'integer' })
  lineTotal!: number;
}
