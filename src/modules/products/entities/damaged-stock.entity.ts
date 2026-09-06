import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * Quarantine inventory: goods a rep returned as DAMAGED/EXPIRED, kept OUT of the
 * sellable van stock. Accrued per (rep, product, pool), mirroring van_stock, when
 * the damaged-returns feature is on. See docs/SPEC-damaged-expired-returns.md.
 */
@Entity({ name: 'damaged_stock' })
@Unique('uq_damaged_stock_rep_product_unit', ['repId', 'productId', 'stockUnitCode'])
export class DamagedStock {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_damaged_stock_rep')
  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Index('idx_damaged_stock_product')
  @Column({ name: 'product_id', type: 'uuid' })
  productId!: string;

  @Column({ name: 'stock_unit_code', type: 'text', default: '' })
  stockUnitCode!: string;

  @Column({ type: 'integer', default: 0 })
  quantity!: number;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
