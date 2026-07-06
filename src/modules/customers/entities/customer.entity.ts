import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export type CustomerType = 'CASH' | 'CREDIT' | 'WHOLESALE' | 'RETAIL';
export type CustomerCategory = 'retail' | 'wholesale' | 'horeca' | 'pharmacy' | string;

@Entity({ name: 'customers' })
export class Customer extends BaseEntity {
  @Index('uq_customers_customer_number', { unique: true })
  @Column({ name: 'customer_number', type: 'text' })
  customerNumber!: string;

  @Column({ name: 'customer_name', type: 'text' })
  customerName!: string;

  // ---- VanFlow bilingual + contact ----
  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text', nullable: true })
  nameEn?: string | null;

  @Column({ type: 'text', nullable: true })
  phone?: string | null;

  @Column({ name: 'phone_hash', type: 'text', nullable: true, select: false })
  phoneHash?: string | null;

  @Column({ name: 'address_ar', type: 'text', nullable: true })
  addressAr?: string | null;

  @Column({ type: 'text', nullable: true })
  city?: string | null;

  @Column({ name: 'city_code', type: 'text', nullable: true })
  cityCode?: string | null;

  @Column({ type: 'text', nullable: true })
  location?: string | null;

  @Column({ type: 'numeric', precision: 9, scale: 6, nullable: true })
  longitude?: string | null;

  @Column({ type: 'numeric', precision: 9, scale: 6, nullable: true })
  latitude?: string | null;

  // ---- assignment ----
  @Index('idx_customers_rep_id')
  @Column({ name: 'rep_id', type: 'uuid', nullable: true })
  repId?: string | null;

  @Index('idx_customers_region_id')
  @Column({ name: 'region_id', type: 'uuid', nullable: true })
  regionId?: string | null;

  @Index('idx_customers_category')
  @Column({ type: 'text', nullable: true })
  category?: CustomerCategory | null;

  // ---- commercial ----
  @Column({
    name: 'credit_limit',
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
  })
  creditLimit!: string;

  @Column({ name: 'payment_terms', type: 'integer', default: 30 })
  paymentTerms!: number;

  /** AR credit hold — when true, block ALL credit (on-account) sales regardless of
   * limit. Mirrored from the ERP customer. See docs/SPEC-accounts-receivable.md. */
  @Column({ name: 'credit_hold', type: 'boolean', default: false })
  creditHold!: boolean;

  @Column({ name: 'customer_type', type: 'text', default: 'CASH' })
  customerType!: CustomerType;

  @Column({
    name: 'total_debt',
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
  })
  totalDebt!: string;

  @Column({
    name: 'total_credit',
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
  })
  totalCredit!: string;

  /** Email — mirrors the ERP customer's email. */
  @Column({ type: 'text', nullable: true })
  email?: string | null;

  // ---- JoFotara buyer identity (required for invoices >= 10,000 JOD) ----
  @Column({ type: 'text', nullable: true })
  tin?: string | null;

  @Column({ type: 'text', nullable: true })
  nin?: string | null;

  @Column({ name: 'passport_number', type: 'text', nullable: true })
  passportNumber?: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  // ---- ERP customer pricing (mirrored from the ERP; see customer_prices) ----
  /** The ERP price list assigned to this customer (informational). */
  @Column({ name: 'erp_price_list_id', type: 'text', nullable: true })
  erpPriceListId?: string | null;

  @Column({ name: 'erp_price_list_name', type: 'text', nullable: true })
  erpPriceListName?: string | null;

  /** When false, the rep may NOT edit the contracted price in the app. */
  @Column({ name: 'allow_manual_price_edit', type: 'boolean', default: true })
  allowManualPriceEdit!: boolean;

  /** Assigned price list (FK → price_lists.id; local or ERP-mirrored). Drives
   * resolution: price-list item price applies unless a customer_prices override wins. */
  @Column({ name: 'price_list_id', type: 'uuid', nullable: true })
  priceListId?: string | null;
}
