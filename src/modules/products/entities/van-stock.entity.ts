import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/** Current loaded quantity of a product on a rep's van. Upsert per (rep, product). */
@Entity({ name: 'van_stock' })
@Unique('uq_van_stock_rep_product', ['repId', 'productId'])
export class VanStock {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_van_stock_rep')
  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Index('idx_van_stock_product')
  @Column({ name: 'product_id', type: 'uuid' })
  productId!: string;

  @Column({ type: 'integer', default: 0 })
  quantity!: number;

  @Column({ name: 'loaded_at', type: 'timestamptz', nullable: true })
  loadedAt?: Date | null;

  @Column({ name: 'snapshot_at', type: 'timestamptz', default: () => 'now()' })
  snapshotAt!: Date;
}
