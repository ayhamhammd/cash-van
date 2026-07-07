import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type AccountEntryKind =
  | 'SALE'
  | 'COLLECTION'
  | 'CHEQUE'
  | 'SETTLEMENT_OUT'
  | 'SETTLEMENT_IN';

/**
 * A signed ledger row on a cash account. Balance = SUM(amount_fils) per account (derived,
 * never stored). Auto-entries (SALE/COLLECTION/CHEQUE) are idempotent per source ref via
 * the unique (ref_type, ref_id, entry_kind). See docs/SPEC-eod-rep-cash-accounts.md.
 */
@Entity({ name: 'account_transactions' })
@Index('idx_acct_txn_account_created', ['accountId', 'createdAt'])
@Index('idx_acct_txn_settlement', ['settlementId'])
@Index('uq_acct_txn_ref', ['refType', 'refId', 'entryKind'], {
  unique: true,
  where: '"ref_type" IS NOT NULL AND "ref_id" IS NOT NULL',
})
export class AccountTransaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ name: 'entry_kind', type: 'text' })
  entryKind!: AccountEntryKind;

  /** Signed fils: + into the account, − out. */
  @Column({ name: 'amount_fils', type: 'bigint' })
  amountFils!: string;

  @Column({ type: 'text' })
  label!: string;

  @Column({ name: 'rep_id', type: 'uuid', nullable: true })
  repId?: string | null;

  @Column({ name: 'ref_type', type: 'text', nullable: true })
  refType?: string | null;

  @Column({ name: 'ref_id', type: 'text', nullable: true })
  refId?: string | null;

  @Column({ name: 'settlement_id', type: 'uuid', nullable: true })
  settlementId?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
