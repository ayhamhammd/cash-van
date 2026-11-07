import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Mirror of one invoice line on a stop. Phase 1 fills only the invoiced side;
 * delivered_qty / reason_code / note / condition / approved_qty are phase 2–3.
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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
