import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Mirror of one invoice line on a stop. invoiced_qty is the invoice line's
 * quantity less what was already returned on it. delivered_qty / reason_code /
 * condition / note come from the ERP's item results (lines it does not list
 * were delivered in full); approved_qty is phase 3.
 */
@Entity({ name: 'delivery_stop_lines' })
@Index('uq_delivery_stop_lines_item', ['stopId', 'erpInvoiceItemId'], { unique: true })
export class DeliveryStopLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'stop_id', type: 'uuid' })
  stopId!: string;

  @Column({ name: 'erp_invoice_item_id', type: 'text' })
  erpInvoiceItemId!: string;

  @Column({ name: 'line_no', type: 'integer', nullable: true })
  lineNo?: number | null;

  @Column({ name: 'sku_code', type: 'text', nullable: true })
  skuCode?: string | null;

  @Column({ name: 'name_ar', type: 'text', nullable: true })
  nameAr?: string | null;

  @Column({ name: 'name_en', type: 'text', nullable: true })
  nameEn?: string | null;

  @Column({ type: 'text', nullable: true })
  unit?: string | null;

  @Column({ name: 'invoiced_qty', type: 'numeric', default: 0 })
  invoicedQty!: string;

  /** The invoice line's billed quantity — what line_total_fils is the price of. */
  @Column({ name: 'billed_qty', type: 'numeric', nullable: true })
  billedQty?: string | null;

  /** The invoice line's total, tax included, in fils. */
  @Column({ name: 'line_total_fils', type: 'bigint', default: 0 })
  lineTotalFils!: string;

  @Column({ name: 'unit_price_fils', type: 'bigint', default: 0 })
  unitPriceFils!: string;

  @Column({ name: 'tax_rate', type: 'numeric', nullable: true })
  taxRate?: string | null;

  @Column({ name: 'delivered_qty', type: 'numeric', nullable: true })
  deliveredQty?: string | null;

  @Column({ name: 'reason_code', type: 'text', nullable: true })
  reasonCode?: string | null;

  @Column({ type: 'text', nullable: true })
  note?: string | null;

  @Column({ type: 'text', nullable: true })
  condition?: string | null;

  @Column({ name: 'approved_qty', type: 'numeric', nullable: true })
  approvedQty?: string | null;

  // ---- the phone's line result while the stop's result is in flight --------

  /** What the phone says was delivered; every line of the stop gets one at intake. */
  @Column({ name: 'local_delivered_qty', type: 'numeric', nullable: true })
  localDeliveredQty?: string | null;

  @Column({ name: 'local_reason_code', type: 'text', nullable: true })
  localReasonCode?: string | null;

  @Column({ name: 'local_note', type: 'text', nullable: true })
  localNote?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
