import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { Customer } from '../../customers/entities/customer.entity';
import { Vendor } from '../../vendors/entities/vendor.entity';
import { TransactionKind } from './transaction-kind.entity';
import { VoucherTransaction } from './voucher-transaction.entity';
import { Payment } from './payment.entity';

@Entity({ name: 'voucher_headers' })
@Index('idx_voucher_headers_trans_kind', ['transKind'])
@Index('idx_voucher_headers_in_date', ['inDate'])
export class VoucherHeader extends BaseEntity {
  @Index('uq_voucher_headers_voucher_number', { unique: true })
  @Column({ name: 'voucher_number', type: 'text' })
  voucherNumber!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_code', referencedColumnName: 'userNumber' })
  user!: User;

  @Column({ name: 'user_code', type: 'text' })
  userCode!: string;

  @Column({ name: 'in_date', type: 'timestamptz', default: () => 'now()' })
  inDate!: Date;

  @ManyToOne(() => TransactionKind, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'trans_kind', referencedColumnName: 'transKind' })
  transactionKind!: TransactionKind;

  @Column({ name: 'trans_kind', type: 'text' })
  transKind!: string;

  /** For RETURN vouchers: the original SALE voucher number this return is against. */
  @Column({ name: 'reference_voucher_number', type: 'text', nullable: true })
  referenceVoucherNumber?: string | null;

  @ManyToOne(() => Customer, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'customer_number', referencedColumnName: 'customerNumber' })
  customer?: Customer | null;

  @Column({ name: 'customer_number', type: 'text', nullable: true })
  customerNumber?: string | null;

  @ManyToOne(() => Vendor, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'vendor_number', referencedColumnName: 'vendorNumber' })
  vendor?: Vendor | null;

  @Column({ name: 'vendor_number', type: 'text', nullable: true })
  vendorNumber?: string | null;

  @Column({ name: 'total_tax', type: 'numeric', precision: 14, scale: 3, default: 0 })
  totalTax!: string;

  @Column({ type: 'numeric', precision: 14, scale: 3, default: 0 })
  total!: string;

  @Column({ name: 'net_total', type: 'numeric', precision: 14, scale: 3, default: 0 })
  netTotal!: string;

  @Column({ name: 'total_discount_value', type: 'numeric', precision: 14, scale: 3, default: 0 })
  totalDiscountValue!: string;

  @Column({ name: 'total_discount_percentage', type: 'numeric', precision: 5, scale: 2, default: 0 })
  totalDiscountPercentage!: string;

  /** Ids of offers applied to this sale (offers engine). Empty when none. */
  @Column({ name: 'applied_offer_ids', type: 'jsonb', default: () => "'[]'::jsonb" })
  appliedOfferIds!: string[];

  @Column({ name: 'is_posted', type: 'boolean', default: false })
  isPosted!: boolean;

  @Column({ name: 'is_edit', type: 'boolean', default: false })
  isEdit!: boolean;

  /** ORDER vouchers only: reservation released + shipped from the van. */
  @Column({ name: 'is_fulfilled', type: 'boolean', default: false })
  isFulfilled!: boolean;

  @OneToMany(() => VoucherTransaction, (t) => t.header, { cascade: true })
  transactions?: VoucherTransaction[];

  @OneToMany(() => Payment, (p) => p.header, { cascade: true })
  payments?: Payment[];
}
