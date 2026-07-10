import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** REP_SALES/RECEIPTS/CHEQUES = a salesman box; COMPANY = a destination account. */
export type CashAccountKind =
  | 'REP_SALES'
  | 'REP_RECEIPTS'
  | 'REP_CHEQUES'
  | 'COMPANY';

/**
 * A cash "box"/account. A rep box holds one kind (sales/receipts/cheques). rep_id NULL =
 * a SHARED box (all reps of that kind combine into it) or a COMPANY destination account.
 * Each account may link to an ERP GL account. See docs/SPEC-eod-rep-cash-accounts.md.
 */
@Entity({ name: 'cash_accounts' })
export class CashAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uq_cash_accounts_code', { unique: true })
  @Column({ type: 'text' })
  code!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  kind!: CashAccountKind;

  /** Owner rep. NULL = shared/combined box or a company account. */
  @Index('idx_cash_accounts_rep_kind')
  @Column({ name: 'rep_id', type: 'uuid', nullable: true })
  repId?: string | null;

  /** Linked ERP chart-of-accounts id (GL mapping); NULL = dashboard-ledger only. */
  @Column({ name: 'erp_account_id', type: 'text', nullable: true })
  erpAccountId?: string | null;

  @Column({ name: 'erp_account_code', type: 'text', nullable: true })
  erpAccountCode?: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
