import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { ExpiryItem } from './expiry-item.entity';

export type TaxType = 'TAXABLE' | 'INCLUSIVE' | 'EXEMPT';
export type TaxCategory = 'S' | 'Z' | 'E';

/**
 * Products. Historically `item_cart`; extended in plan 04 with VanFlow product
 * fields. Legacy FKs (item_switch, voucher_transactions, expiry_items) still
 * reference the text `item_number`; new tables (van_stock, price_rules) FK the
 * UUID `id`.
 */
@Entity({ name: 'item_cart' })
export class ItemCart extends BaseEntity {
  @Index('uq_item_cart_item_number', { unique: true })
  @Column({ name: 'item_number', type: 'text' })
  itemNumber!: string;

  @Column({ name: 'item_name', type: 'text' })
  name!: string;

  @Index('uq_item_cart_barcode', { unique: true })
  @Column({ type: 'text' })
  barcode!: string;

  // ---- VanFlow product fields (plan 04) ----
  @Column({ type: 'text' })
  sku!: string;

  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text', nullable: true })
  nameEn?: string | null;

  @Column({ name: 'category_id', type: 'uuid', nullable: true })
  categoryId?: string | null;

  @Column({ type: 'text', default: 'carton' })
  unit!: string;

  @Column({ name: 'unit_of_measure', type: 'text', default: 'PCE' })
  unitOfMeasure!: string;

  /** Sale price in fils (minor units). */
  @Column({ type: 'integer', default: 0 })
  price!: number;

  /** Cost in fils. */
  @Column({ type: 'integer', nullable: true })
  cost?: number | null;

  @Column({ name: 'image_url', type: 'text', nullable: true })
  imageUrl?: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'reorder_qty', type: 'integer', default: 0 })
  reorderQty!: number;

  @Column({ name: 'tax_type', type: 'text', default: 'TAXABLE' })
  taxType!: TaxType;

  @Column({ name: 'tax_category', type: 'text', default: 'S' })
  taxCategory!: TaxCategory;

  @Column({ name: 'tax_rate', type: 'numeric', precision: 5, scale: 4, default: 0.16 })
  taxRate!: string;

  // ---- legacy ----
  @Column({
    name: 'tax_percentage',
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
  })
  taxPercentage!: string;

  @Column({ name: 'photo_url', type: 'text', nullable: true })
  photoUrl?: string | null;

  @OneToMany(() => ExpiryItem, (ex) => ex.item)
  expiries?: ExpiryItem[];
}
