import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Lookup table — trans_kind is a stable business code (e.g. SALE, PURCHASE,
 * RETURN_IN, RETURN_OUT, PAYMENT_IN, PAYMENT_OUT, ADJUSTMENT). The `sign`
 * column drives how the item_balance view aggregates qty.
 */
@Entity({ name: 'transaction_kinds' })
export class TransactionKind {
  @PrimaryColumn({ name: 'trans_kind', type: 'text' })
  transKind!: string;

  @Column({ name: 'trans_name', type: 'text' })
  transName!: string;

  @Column({
    type: 'smallint',
    default: 0,
    comment: '+1 increases stock (purchase/return-in), -1 decreases (sale/return-out), 0 = no stock effect',
  })
  sign!: number;
}
