import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Invoice } from './invoice.entity';
import type { TaxCategory, TaxType } from '../../items/entities/item-cart.entity';

export type LineDiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT';

@Entity({ name: 'invoice_lines' })
export class InvoiceLine {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_invoice_lines_invoice')
  @Column({ name: 'invoice_id', type: 'uuid' })
  invoiceId!: string;

  @ManyToOne(() => Invoice, (i) => i.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'invoice_id' })
  invoice?: Invoice;

  @Index('idx_invoice_lines_product')
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

  @Column({ name: 'line_discount_type', type: 'text', default: 'PERCENTAGE' })
  lineDiscountType!: LineDiscountType;

  @Column({ name: 'line_discount_value', type: 'numeric', precision: 14, scale: 3, default: 0 })
  lineDiscountValue!: string;

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
