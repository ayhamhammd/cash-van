import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { VoucherHeader } from './voucher-header.entity';

export type PaymentType = 'CASH' | 'CHEQUE' | 'TRANSFER' | 'CARD' | 'CREDIT';

@Entity({ name: 'payments' })
@Index('idx_payments_voucher_number', ['voucherNumber'])
@Index('idx_payments_date', ['paymentDate'])
export class Payment extends BaseEntity {
  @ManyToOne(() => VoucherHeader, (h) => h.payments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'voucher_number', referencedColumnName: 'voucherNumber' })
  header!: VoucherHeader;

  @Column({ name: 'voucher_number', type: 'text' })
  voucherNumber!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Column({ name: 'payment_date', type: 'timestamptz', default: () => 'now()' })
  paymentDate!: Date;

  @Column({ name: 'from_acc', type: 'text', nullable: true })
  fromAcc?: string | null;

  @Column({ name: 'to_acc', type: 'text', nullable: true })
  toAcc?: string | null;

  @Column({ name: 'payment_type', type: 'text', default: 'CASH' })
  paymentType!: PaymentType;
}
