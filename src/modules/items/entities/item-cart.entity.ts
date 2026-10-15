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

  /** ERP category id (chosen on the form) used when mirroring this item to the ERP. */
  @Column({ name: 'erp_category_id', type: 'text', nullable: true })
  erpCategoryId?: string | null;

  /** ERP tax-rate id used when mirroring this item to the ERP. */
  @Column({ name: 'erp_tax_rate_id', type: 'text', nullable: true })
  erpTaxRateId?: string | null;

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

  // ── Tobacco tax (mirrors the ERP product tobacco fields) ───────────────────
  /** When true this item uses tobacco tax (via tobaccoTaxProfileId), not GST. */
  @Column({ name: 'is_tobacco_product', type: 'boolean', default: false })
  isTobaccoProduct!: boolean;

  // ── Returnable packaging (mirrored from the ERP; see migration 0181) ──────
  // An empty container is an item in its own right and is NEVER SOLD — the
  // customer is handed a tub of halloumi, not a bucket. So an ordinary item
  // points at the container it ships in, containers going out are DERIVED from
  // sale lines, and only the movement of empties is a document. See
  // docs/PLAN-returnable-containers.md.

  /** This item IS an empty container. Zero price; only container documents may name it. */
  @Column({ name: 'is_returnable_container', type: 'boolean', default: false })
  isReturnableContainer!: boolean;

  /**
   * The container this item ships in, by `item_number` — null for everything
   * that does not ship in one.
   *
   * An item_number rather than an id because erp-sync has already resolved the
   * ERP's container SKU through `erp_id_map`, and a voucher line names items
   * this way. Nothing else in the schema would let a line reference it.
   */
  @Column({ name: 'container_item_number', type: 'text', nullable: true })
  containerItemNumber?: string | null;

  /**
   * Containers per BASE PIECE, not per line.
   *
   * A 6 kg tub carries one bucket; a carton of four tubs carries four. The
   * outstanding-balance derivation multiplies BASE PIECES
   * (`item_qty × unit_base_qty`) by this, so a line entered in cartons counts
   * four containers and not one — the single most likely place for this feature
   * to under-count.
   */
  @Column({ name: 'containers_per_base_unit', type: 'integer', default: 1 })
  containersPerBaseUnit!: number;

  /** FK to tobacco_tax_profiles (no DB constraint — profile may be deactivated). */
  @Column({ name: 'tobacco_tax_profile_id', type: 'uuid', nullable: true })
  tobaccoTaxProfileId?: string | null;

  /** MSRP / consumer price used as a tobacco tax base, in integer fils per base piece. */
  @Column({ name: 'consumer_price_fils', type: 'integer', nullable: true })
  consumerPriceFils?: number | null;

  /**
   * The ERP "Item Alternatives" group this item belongs to — every mutually
   * substitutable item shares one key (the lowest item number in the set).
   * NULL when the ERP declares no alternative for it, and an item with no group
   * is never treated as a substitute for anything. Mirrored by erp-sync; the
   * receipt's line merge is the consumer.
   */
  @Index('idx_item_cart_alt_group')
  @Column({ name: 'alt_group', type: 'text', nullable: true })
  altGroup?: string | null;

  @OneToMany(() => ExpiryItem, (ex) => ex.item)
  expiries?: ExpiryItem[];
}
