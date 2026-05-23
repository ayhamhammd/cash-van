import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { VoucherHeader } from './voucher-header.entity';
import { ItemCart } from '../../items/entities/item-cart.entity';
import { TransactionKind } from './transaction-kind.entity';
import { Warehouse } from '../../warehouses/entities/warehouse.entity';

@Entity({ name: 'voucher_transactions' })
@Index('idx_voucher_transactions_voucher_number', ['voucherNumber'])
@Index('idx_voucher_transactions_item_number', ['itemNumber'])
export class VoucherTransaction extends BaseEntity {
  @ManyToOne(() => VoucherHeader, (h) => h.transactions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'voucher_number', referencedColumnName: 'voucherNumber' })
  header!: VoucherHeader;

  @Column({ name: 'voucher_number', type: 'text' })
  voucherNumber!: string;

  @ManyToOne(() => ItemCart, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'item_number', referencedColumnName: 'itemNumber' })
  item!: ItemCart;

  @Column({ name: 'item_number', type: 'text' })
  itemNumber!: string;

  @Column({ name: 'item_name', type: 'text' })
  itemName!: string;

  @ManyToOne(() => TransactionKind, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'trans_kind', referencedColumnName: 'transKind' })
  transactionKind!: TransactionKind;

  @Column({ name: 'trans_kind', type: 'text' })
  transKind!: string;

  @ManyToOne(() => Warehouse, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'store_number', referencedColumnName: 'whNumber' })
  warehouse?: Warehouse | null;

  @Column({ name: 'store_number', type: 'text', nullable: true })
  storeNumber?: string | null;

  @Column({ name: 'tax_percentage', type: 'numeric', precision: 5, scale: 2, default: 0 })
  taxPercentage!: string;

  @Column({ name: 'discount_percentage', type: 'numeric', precision: 5, scale: 2, default: 0 })
  discountPercentage!: string;

  @Column({ name: 'discount_value', type: 'numeric', precision: 14, scale: 2, default: 0 })
  discountValue!: string;

  @Column({ name: 'real_date', type: 'timestamptz', default: () => 'now()' })
  realDate!: Date;

  @Column({ name: 'exported_date', type: 'timestamptz', nullable: true })
  exportedDate?: Date | null;

  @Column({ name: 'item_qty', type: 'numeric', precision: 14, scale: 3 })
  itemQty!: string;

  @Column({ name: 'signed_qty', type: 'numeric', precision: 14, scale: 3, default: 0 })
  signedQty!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  total!: string;

  @Column({ name: 'net_total', type: 'numeric', precision: 14, scale: 2, default: 0 })
  netTotal!: string;
}
