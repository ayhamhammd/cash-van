import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * A customer's contract/list price for one ERP SKU (unit), mirrored from the ERP's
 * resolved pricing (`GET /api/v1/prices?customerCode=`). One row per (customer, ERP
 * SKU) — only real overrides are stored (ERP `DEFAULT_PRICE` rows are dropped). The
 * ERP is the master; these rows are ERP-owned and rebuilt on each sync.
 */
@Entity({ name: 'customer_prices' })
@Index('uq_customer_price_customer_sku', ['customerId', 'erpSku'], { unique: true })
export class CustomerPrice extends BaseEntity {
  @Index('idx_customer_prices_customer')
  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  /** Resolved cash-van item (`item_cart.id`); null if the SKU isn't mapped yet. */
  @Column({ name: 'item_id', type: 'uuid', nullable: true })
  itemId?: string | null;

  /** The specific pack (`item_units.id`) when the SKU is a larger unit; null = base. */
  @Column({ name: 'item_unit_id', type: 'uuid', nullable: true })
  itemUnitId?: string | null;

  /** The ERP SKU code this price is for (mapping/debug key). */
  @Column({ name: 'erp_sku', type: 'text' })
  erpSku!: string;

  /** The unit barcode (matches `item_units.barcode` / the device unit id). */
  @Column({ type: 'text', nullable: true })
  barcode?: string | null;

  /** The contracted unit price in fils. */
  @Column({ name: 'unit_price', type: 'integer' })
  unitPrice!: number;

  /** ERP price source: CUSTOMER_PRICE | PRICE_LIST (never DEFAULT_PRICE — filtered out). */
  @Column({ name: 'price_source', type: 'text', nullable: true })
  priceSource?: string | null;

  /** The ERP price list this resolved from (informational). */
  @Column({ name: 'erp_price_list_id', type: 'text', nullable: true })
  erpPriceListId?: string | null;

  @Column({ name: 'synced_at', type: 'timestamptz', nullable: true })
  syncedAt?: Date | null;

  /**
   * Row owner: 'erp' — mirrored from the ERP, rebuilt/pruned on each sync;
   * 'local' — authored on the FlowVan dashboard, sticky (sync never touches it).
   */
  @Column({ type: 'text', default: 'erp' })
  origin!: string;
}
