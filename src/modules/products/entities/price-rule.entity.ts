import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * Pricing rule. A NULL `productId` applies to all products; a NULL
 * `customerSegment` applies to all segments. `fixedPrice` (fils) overrides
 * `discountPct` when set.
 */
@Entity({ name: 'price_rules' })
export class PriceRule extends BaseEntity {
  @Index('idx_price_rules_product')
  @Column({ name: 'product_id', type: 'uuid', nullable: true })
  productId?: string | null;

  @Column({ name: 'customer_segment', type: 'text', nullable: true })
  customerSegment?: string | null;

  @Column({ name: 'min_qty', type: 'integer', default: 1 })
  minQty!: number;

  @Column({ name: 'discount_pct', type: 'real', default: 0 })
  discountPct!: number;

  @Column({ name: 'fixed_price', type: 'integer', nullable: true })
  fixedPrice?: number | null;

  @Column({ name: 'valid_from', type: 'date', nullable: true })
  validFrom?: string | null;

  @Column({ name: 'valid_to', type: 'date', nullable: true })
  validTo?: string | null;
}
