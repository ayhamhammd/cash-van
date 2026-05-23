import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { ItemCart } from './item-cart.entity';

@Entity({ name: 'item_switch' })
@Index('uq_item_switch_item_unit', ['itemNumber', 'unitName'], { unique: true })
@Index('uq_item_switch_barcode', ['barcode'], { unique: true })
export class ItemSwitch extends BaseEntity {
  @ManyToOne(() => ItemCart, (item) => item.switches, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'item_number', referencedColumnName: 'itemNumber' })
  item!: ItemCart;

  @Column({ name: 'item_number', type: 'text' })
  itemNumber!: string;

  @Column({ type: 'text' })
  barcode!: string;

  @Column({ name: 'unit_qty', type: 'integer', default: 1 })
  unitQty!: number;

  @Column({
    name: 'sale_price',
    type: 'numeric',
    precision: 14,
    scale: 2,
  })
  salePrice!: string;

  @Column({ name: 'item_name', type: 'text' })
  itemName!: string;

  @Column({ name: 'unit_name', type: 'text' })
  unitName!: string;
}
