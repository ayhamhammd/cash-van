import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity({ name: 'warehouses' })
export class Warehouse extends BaseEntity {
  @Index('uq_warehouses_wh_number', { unique: true })
  @Column({ name: 'wh_number', type: 'text' })
  whNumber!: string;

  @Column({ name: 'wh_name', type: 'text' })
  whName!: string;

  @Column({ name: 'wh_address', type: 'text', nullable: true })
  whAddress?: string | null;

  /** Store type: true = van store (tied to cart/SALE/RETURN/ORDER), false = normal depot. */
  @Column({ name: 'is_van', type: 'boolean', default: false })
  isVan!: boolean;

  /**
   * The ERP's "main store" — the central depot the ORDER flow draws from. Mirrored
   * from the ERP warehouse `isMain` flag on every sync, so the main store is
   * detected FROM the ERP rather than guessed. An explicit settings.mainStoreNumber
   * still overrides it.
   */
  @Column({ name: 'is_main', type: 'boolean', default: false })
  isMain!: boolean;

  /**
   * May this store's pools go below zero?
   *
   * Per warehouse, not per organisation: a van's stock is genuinely uncertain
   * between the morning load and the day closing, and the main store has no such
   * excuse — if it is short, something is wrong and the sale should stop. Named
   * and defaulted to match the ERP's own column, because both sides have to
   * agree about which vans may hold a negative.
   *
   * Only consulted through `mayGoNegative`, which refuses a non-van whatever
   * this says.
   */
  @Column({ name: 'allow_negative_stock', type: 'boolean', default: false })
  allowNegativeStock!: boolean;

  @Column({
    name: 'wh_credit_box',
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
  })
  whCreditBox!: string;

  @Column({
    name: 'wh_debit_box',
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
  })
  whDebitBox!: string;
}
