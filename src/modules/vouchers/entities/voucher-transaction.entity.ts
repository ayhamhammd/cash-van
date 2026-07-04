import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { VoucherHeader } from './voucher-header.entity';
import { ItemCart } from '../../items/entities/item-cart.entity';
import { TransactionKind } from './transaction-kind.entity';
import { Warehouse } from '../../warehouses/entities/warehouse.entity';

@Entity({ name: 'voucher_transactions' })
@Index('idx_voucher_transactions_voucher_number', ['voucherNumber'])
@Index('idx_voucher_transactions_item_number', ['itemNumber'])
export class VoucherTransaction extends BaseEntity {
  @ManyToOne(() => VoucherHeader, (h) => h.transactions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'voucher_number', referencedColumnName: 'voucherNumber' })
  header!: VoucherHeader;

  @Column({ name: 'voucher_number', type: 'text' })
  voucherNumber!: string;

  @ManyToOne(() => ItemCart, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_number', referencedColumnName: 'itemNumber' })
  item!: ItemCart;

  @Column({ name: 'item_number', type: 'text' })
  itemNumber!: string;

  @Column({ name: 'item_name', type: 'text' })
  itemName!: string;

  @ManyToOne(() => TransactionKind, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'trans_kind', referencedColumnName: 'transKind' })
  transactionKind!: TransactionKind;

  @Column({ name: 'trans_kind', type: 'text' })
  transKind!: string;

  @ManyToOne(() => Warehouse, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'store_number', referencedColumnName: 'whNumber' })
  warehouse?: Warehouse | null;

  /**
   * Legacy single-store column. Kept in sync with the from/to columns below for
   * backward compatibility (= the store affected by this line).
   */
  @Column({ name: 'store_number', type: 'text', nullable: true })
  storeNumber?: string | null;

  /**
   * Stock that LOSES qty from this line (outflow). Set for SALE and the OUT
   * side of a TRANSFER. Null when the line only adds stock.
   */
  @ManyToOne(() => Warehouse, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'from_store_number', referencedColumnName: 'whNumber' })
  fromStore?: Warehouse | null;

  @Column({ name: 'from_store_number', type: 'text', nullable: true })
  fromStoreNumber?: string | null;

  /**
   * Stock that GAINS qty from this line (inflow). Set for RETURN and the IN
   * side of a TRANSFER. Null when the line only removes stock.
   */
  @ManyToOne(() => Warehouse, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'to_store_number', referencedColumnName: 'whNumber' })
  toStore?: Warehouse | null;

  @Column({ name: 'to_store_number', type: 'text', nullable: true })
  toStoreNumber?: string | null;

  @Column({ name: 'tax_percentage', type: 'numeric', precision: 5, scale: 2, default: 0 })
  taxPercentage!: string;

  @Column({ name: 'discount_percentage', type: 'numeric', precision: 5, scale: 2, default: 0 })
  discountPercentage!: string;

  @Column({ name: 'discount_value', type: 'numeric', precision: 14, scale: 3, default: 0 })
  discountValue!: string;

  @Column({ name: 'real_date', type: 'timestamptz', default: () => 'now()' })
  realDate!: Date;

  @Column({ name: 'exported_date', type: 'timestamptz', nullable: true })
  exportedDate?: Date | null;

  @Column({ name: 'item_qty', type: 'numeric', precision: 14, scale: 3 })
  itemQty!: string;

  /** Price per chosen unit at the time of the voucher (for receipts). */
  @Column({ name: 'unit_price', type: 'numeric', precision: 14, scale: 3, default: 0 })
  unitPrice!: string;

  /** Quantity the user entered in the chosen unit (e.g. 3 boxes). */
  @Column({ name: 'qty_of_unit', type: 'numeric', precision: 14, scale: 3, nullable: true })
  qtyOfUnit?: string | null;

  /** Unit code/number used for this line (e.g. "PK6"). Null for base pieces. */
  @Column({ name: 'unit_code', type: 'text', nullable: true })
  unitCode?: string | null;

  /** Unit display-name snapshot. */
  @Column({ name: 'unit_name', type: 'text', nullable: true })
  unitName?: string | null;

  /** Pieces per unit (conversion factor): item_qty = qty_of_unit × unit_base_qty. */
  @Column({ name: 'unit_base_qty', type: 'integer', nullable: true })
  unitBaseQty?: number | null;

  @Column({ name: 'signed_qty', type: 'numeric', precision: 14, scale: 3, default: 0 })
  signedQty!: string;

  @Column({ type: 'numeric', precision: 14, scale: 3, default: 0 })
  total!: string;

  @Column({ name: 'net_total', type: 'numeric', precision: 14, scale: 3, default: 0 })
  netTotal!: string;

  // ── Tobacco tax snapshot (frozen at sale time; mirrors the ERP invoice line) ─
  /** True when this line's tax is tobacco tax (GST bypassed). */
  @Column({ name: 'is_tobacco_line', type: 'boolean', default: false })
  isTobaccoLine!: boolean;

  @Column({ name: 'tobacco_tax_profile_id', type: 'text', nullable: true })
  tobaccoTaxProfileId?: string | null;

  /** Consumer price per base piece, integer fils. */
  @Column({ name: 'consumer_price_fils', type: 'integer', nullable: true })
  consumerPriceFils?: number | null;

  /** consumerPrice × base qty, integer fils. */
  @Column({ name: 'consumer_value_fils', type: 'integer', nullable: true })
  consumerValueFils?: number | null;

  @Column({ name: 'tobacco_tax_base_fils', type: 'integer', nullable: true })
  tobaccoTaxBaseFils?: number | null;

  @Column({ name: 'tobacco_sales_tax_rate', type: 'integer', nullable: true })
  tobaccoSalesTaxRate?: number | null;

  @Column({ name: 'tobacco_sales_tax_fils', type: 'integer', default: 0 })
  tobaccoSalesTaxFils!: number;

  @Column({ name: 'tobacco_special_tax_calc_type', type: 'text', nullable: true })
  tobaccoSpecialTaxCalcType?: string | null;

  @Column({ name: 'tobacco_special_tax_rate', type: 'integer', nullable: true })
  tobaccoSpecialTaxRate?: number | null;

  @Column({ name: 'tobacco_special_tax_fixed_fils', type: 'integer', nullable: true })
  tobaccoSpecialTaxFixedFils?: number | null;

  @Column({ name: 'tobacco_special_tax_fils', type: 'integer', default: 0 })
  tobaccoSpecialTaxFils!: number;

  @Column({ name: 'tobacco_withheld_tax_calc_type', type: 'text', nullable: true })
  tobaccoWithheldTaxCalcType?: string | null;

  @Column({ name: 'tobacco_withheld_tax_rate', type: 'integer', nullable: true })
  tobaccoWithheldTaxRate?: number | null;

  @Column({ name: 'tobacco_withheld_tax_fixed_fils', type: 'integer', nullable: true })
  tobaccoWithheldTaxFixedFils?: number | null;

  @Column({ name: 'tobacco_withheld_tax_fils', type: 'integer', default: 0 })
  tobaccoWithheldTaxFils!: number;

  @Column({ name: 'tobacco_gross_tax_fils', type: 'integer', default: 0 })
  tobaccoGrossTaxFils!: number;

  @Column({ name: 'tobacco_net_tax_fils', type: 'integer', default: 0 })
  tobaccoNetTaxFils!: number;

  @Column({ name: 'tobacco_calc_details', type: 'jsonb', nullable: true })
  tobaccoCalcDetails?: Record<string, unknown> | null;
}
