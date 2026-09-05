import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * One priced tier of an item under a price list (fils).
 *
 * A list may hold SEVERAL rows for the same item — the ERP prices per quantity
 * band and per date window, and the van has to be able to answer with the same
 * band the ERP would. Which row applies is decided in PricingService, on the
 * ERP's rule: every band whose quantity and date match, then the one with the
 * HIGHEST minQty (the most specific tier).
 *
 * Identity differs by origin, which is why the two unique indexes are partial:
 * an ERP row is identified by the ERP's own price-list-item id (so a tier can be
 * re-priced or re-banded and still be recognised), while a dashboard-authored
 * row keeps the original one-per-(list, item) rule.
 */
@Entity({ name: 'price_list_items' })
@Index('uq_price_list_item_erp', ['erpItemId'], {
  unique: true,
  where: '"erp_item_id" IS NOT NULL',
})
@Index('uq_price_list_item_local', ['priceListId', 'itemId'], {
  unique: true,
  where: '"erp_item_id" IS NULL',
})
@Index('idx_price_list_items_lookup', ['priceListId', 'itemId'])
export class PriceListItem extends BaseEntity {
  @Index('idx_price_list_items_list')
  @Column({ name: 'price_list_id', type: 'uuid' })
  priceListId!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  /** The ERP's price_list_items.id. NULL ⇒ authored in the dashboard. */
  @Column({ name: 'erp_item_id', type: 'text', nullable: true })
  erpItemId?: string | null;

  /** Unit price in fils under this list. */
  @Column({ name: 'unit_price', type: 'integer' })
  unitPrice!: number;

  /** Lowest quantity this tier applies to. 1 ⇒ applies from a single unit. */
  @Column({ name: 'min_qty', type: 'integer', default: 1 })
  minQty!: number;

  /** Highest quantity this tier applies to. NULL ⇒ no upper bound. */
  @Column({ name: 'max_qty', type: 'integer', nullable: true })
  maxQty?: number | null;

  /** Validity window (inclusive). NULL on either side ⇒ open-ended. */
  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate?: string | null;

  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate?: string | null;

  /** Mirrors the ERP's per-item switch. An inactive tier never prices. */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;
}
