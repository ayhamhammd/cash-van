import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { ItemCart } from './item-cart.entity';
import { Warehouse } from '../../warehouses/entities/warehouse.entity';

@Entity({ name: 'expiry_items' })
@Index('idx_expiry_items_exp_date', ['expDate'])
export class ExpiryItem extends BaseEntity {
  @ManyToOne(() => ItemCart, (item) => item.expiries, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_number', referencedColumnName: 'itemNumber' })
  item!: ItemCart;

  @Column({ name: 'item_number', type: 'text' })
  itemNumber!: string;

  @Column({ name: 'item_name', type: 'text' })
  itemName!: string;

  @Column({ name: 'exp_date', type: 'date' })
  expDate!: string;

  @Column({ name: 'in_date', type: 'date' })
  inDate!: string;

  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate?: string | null;

  @ManyToOne(() => Warehouse, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'store_number', referencedColumnName: 'whNumber' })
  warehouse?: Warehouse | null;

  @Column({ name: 'store_number', type: 'text', nullable: true })
  storeNumber?: string | null;
}
