import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Cheque } from './cheque.entity';

export type CollectionMethod = 'cash' | 'cheque' | 'transfer';
export type CollectionStatus = 'pending' | 'confirmed' | 'deposited' | 'bounced';

@Entity({ name: 'collections' })
export class Collection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_collections_rep_collected')
  @Column({ name: 'rep_id', type: 'uuid' })
  repId!: string;

  @Index('idx_collections_customer_status')
  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  /** Per-warehouse payment number (C series), e.g. C-VAN-01-000001. */
  @Column({ name: 'collection_number', type: 'text', nullable: true })
  collectionNumber?: string | null;

  @Column({ name: 'invoice_id', type: 'uuid', nullable: true })
  invoiceId?: string | null;

  @Column({ name: 'payment_id', type: 'uuid', nullable: true })
  paymentId?: string | null;

  /** fils */
  @Column({ type: 'integer' })
  amount!: number;

  @Column({ type: 'text' })
  method!: CollectionMethod;

  @Index('idx_collections_status_collected')
  @Column({ type: 'text', default: 'pending' })
  status!: CollectionStatus;

  @Column({ name: 'collected_at', type: 'timestamptz', default: () => 'now()' })
  collectedAt!: Date;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt?: Date | null;

  @Column({ name: 'deposited_at', type: 'timestamptz', nullable: true })
  depositedAt?: Date | null;

  /**
   * The bank's reference for a transfer — what an accountant matches against
   * the statement. Its own column rather than `note`, which is free text a rep
   * types and nobody can reconcile on.
   */
  @Column({ name: 'transfer_ref', type: 'text', nullable: true })
  transferRef?: string | null;

  /**
   * The handset's own id for this collection, and the only thing standing
   * between a timed-out retry and crediting the customer twice.
   *
   * Unique where present. A collection created in the office has none.
   */
  @Index('uq_collections_client_ref', { unique: true, where: '"client_ref" IS NOT NULL' })
  @Column({ name: 'client_ref', type: 'text', nullable: true })
  clientRef?: string | null;

  @Column({ type: 'text', nullable: true })
  note?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => Cheque, (c) => c.collection)
  cheques?: Cheque[];
}
