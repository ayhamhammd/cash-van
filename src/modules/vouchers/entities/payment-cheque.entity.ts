import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Customer } from '../../customers/entities/customer.entity';

@Entity({ name: 'payment_cheques' })
@Index('uq_payment_cheques_cheque_number', ['chequeNumber'], { unique: true })
@Index('idx_payment_cheques_due_date', ['dueDate'])
export class PaymentCheque extends BaseEntity {
  @Column({ name: 'bank_name', type: 'text' })
  bankName!: string;

  @Column({ name: 'cheque_number', type: 'text' })
  chequeNumber!: string;

  @Column({ name: 'cheque_date', type: 'date' })
  chequeDate!: string;

  @Column({ name: 'due_date', type: 'date' })
  dueDate!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @ManyToOne(() => Customer, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'customer_number', referencedColumnName: 'customerNumber' })
  customer?: Customer | null;

  @Column({ name: 'customer_number', type: 'text', nullable: true })
  customerNumber?: string | null;

  @Column({ name: 'customer_name', type: 'text', nullable: true })
  customerName?: string | null;
}
