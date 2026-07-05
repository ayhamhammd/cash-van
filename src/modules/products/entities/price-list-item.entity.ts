import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/** One product's price under a price list (fils). Unique per (list, item). */
@Entity({ name: 'price_list_items' })
@Index('uq_price_list_item', ['priceListId', 'itemId'], { unique: true })
export class PriceListItem extends BaseEntity {
  @Index('idx_price_list_items_list')
  @Column({ name: 'price_list_id', type: 'uuid' })
  priceListId!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  /** Unit price in fils under this list. */
  @Column({ name: 'unit_price', type: 'integer' })
  unitPrice!: number;
}
