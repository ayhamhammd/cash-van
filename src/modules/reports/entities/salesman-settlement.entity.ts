import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One End-of-Day cash reconciliation for a salesman over a period. Snapshots the
 * period's aggregates + the running balance: `new_balance = previous + expected −
 * received`. The rep's current outstanding balance is the latest row's
 * `new_balance_fils`. All money in fils. Never mutates sales/collections.
 */
@Entity({ name: 'salesman_settlement' })
@Index('idx_settlement_rep_created', ['repId', 'createdAt'])
export class SalesmanSettlement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Column({ name: 'period_from', type: 'date' })
  periodFrom!: string;

  @Column({ name: 'period_to', type: 'date' })
  periodTo!: string;

  @Column({ name: 'expected_cash_fils', type: 'bigint', default: 0 })
  expectedCashFils!: string;

  @Column({ name: 'collected_cash_fils', type: 'bigint', default: 0 })
  collectedCashFils!: string;

  @Column({ name: 'collected_cheque_fils', type: 'bigint', default: 0 })
  collectedChequeFils!: string;

  @Column({ name: 'cash_sales_fils', type: 'bigint', default: 0 })
  cashSalesFils!: string;

  @Column({ name: 'credit_sales_fils', type: 'bigint', default: 0 })
  creditSalesFils!: string;

  @Column({ name: 'cash_returns_fils', type: 'bigint', default: 0 })
  cashReturnsFils!: string;

  @Column({ name: 'total_discount_fils', type: 'bigint', default: 0 })
  totalDiscountFils!: string;

  @Column({ name: 'previous_balance_fils', type: 'bigint', default: 0 })
  previousBalanceFils!: string;

  @Column({ name: 'received_fils', type: 'bigint', default: 0 })
  receivedFils!: string;

  @Column({ name: 'new_balance_fils', type: 'bigint', default: 0 })
  newBalanceFils!: string;

  @Column({ name: 'note', type: 'text', nullable: true })
  note?: string | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
