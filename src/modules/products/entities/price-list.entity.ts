import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * A named price list (e.g. WHOLESALE). Items priced under it live in
 * `price_list_items`; customers are assigned via `customers.price_list_id`.
 * `origin`: 'local' — authored on this dashboard; 'erp' — mirrored from the ERP
 * (rebuilt on sync). Money is fils throughout.
 */
@Entity({ name: 'price_lists' })
export class PriceList extends BaseEntity {
  @Index('uq_price_lists_code', { unique: true })
  @Column({ type: 'text' })
  code!: string;

  @Column({ type: 'text' })
  name!: string;

  /** 'local' (dashboard-authored, sticky) | 'erp' (mirrored, rebuilt on sync). */
  @Column({ type: 'text', default: 'local' })
  origin!: string;

  /** The ERP price-list id this mirrors (null for local lists). */
  @Index('idx_price_lists_erp_id')
  @Column({ name: 'erp_id', type: 'text', nullable: true })
  erpId?: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;
}
