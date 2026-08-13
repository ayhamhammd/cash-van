import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Unit } from './unit.entity';
import { ItemCart } from '../../items/entities/item-cart.entity';

/**
 * Per-item mapping to a unit. Carries the per-item barcode + sale_price.
 * The conversion factor lives on the unit master (`unit.baseQty`) — piece is
 * always the base (PCE, baseQty=1).
 */
@Entity({ name: 'item_units' })
@Index('uq_item_units_item_unit', ['itemId', 'unitId'], { unique: true })
@Index('idx_item_units_item', ['itemId'])
export class ItemUnit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  @ManyToOne(() => ItemCart, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item?: ItemCart;

  @Column({ name: 'unit_id', type: 'uuid' })
  unitId!: string;

  @ManyToOne(() => Unit, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'unit_id' })
  unit?: Unit;

  @Index('uq_item_units_barcode', { unique: true })
  @Column({ type: 'text' })
  barcode!: string;

  /**
   * Pieces this unit represents FOR THIS ITEM. Defaults to the unit master's
   * baseQty on attach, but can be overridden per item (the same "box" unit may
   * hold a different count for different products).
   */
  @Column({ name: 'qty', type: 'integer', default: 1 })
  qty!: number;

  @Column({
    name: 'sale_price',
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
  })
  salePrice!: string;

  /**
   * True when this unit is a *variant* — a physically different good (أحمر) that
   * owns its own stock pool. False (the default, and every pre-existing row) is
   * a *packaging* unit (كرتونة ×12): a way to enter a quantity of the same
   * goods, drawing from the item's base pool at `qty` pieces each.
   */
  @Column({ name: 'is_stock_unit', type: 'boolean', default: false })
  isStockUnit!: boolean;

  /** The ERP `product_skus.sku` this unit mirrors, so a sale can post against it. */
  @Index('idx_item_units_erp_sku', { where: '"erp_sku_code" IS NOT NULL' })
  @Column({ name: 'erp_sku_code', type: 'text', nullable: true })
  erpSkuCode?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
