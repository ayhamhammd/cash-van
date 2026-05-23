import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Collection } from './collection.entity';

export type ChequeScanSource = 'server' | 'mlkit_offline';
export type ChequeStatus = 'pending' | 'cleared' | 'bounced' | 'cancelled';

@Entity({ name: 'cheques' })
export class Cheque {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_cheques_collection')
  @Column({ name: 'collection_id', type: 'uuid' })
  collectionId!: string;

  @OneToOne(() => Collection, (c) => c.cheque, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'collection_id' })
  collection?: Collection;

  @Column({ name: 'bank_name', type: 'text', nullable: true })
  bankName?: string | null;

  @Column({ name: 'cheque_number', type: 'text', nullable: true })
  chequeNumber?: string | null;

  @Column({ type: 'text', nullable: true })
  payee?: string | null;

  /** fils */
  @Column({ type: 'integer' })
  amount!: number;

  @Column({ name: 'amount_words', type: 'text', nullable: true })
  amountWords?: string | null;

  @Index('idx_cheques_due_date')
  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate?: string | null;

  @Column({ name: 'ocr_confidence', type: 'real', nullable: true })
  ocrConfidence?: number | null;

  @Column({ name: 'words_match', type: 'boolean', default: true })
  wordsMatch!: boolean;

  @Column({ name: 'scan_source', type: 'text', default: 'server' })
  scanSource!: ChequeScanSource;

  @Index('idx_cheques_status')
  @Column({ type: 'text', default: 'pending' })
  status!: ChequeStatus;

  @Column({ name: 'image_path', type: 'text', nullable: true })
  imagePath?: string | null;

  @Column({ name: 'scanned_at', type: 'timestamptz', nullable: true })
  scannedAt?: Date | null;

  @Column({ name: 'reconciled_at', type: 'timestamptz', nullable: true })
  reconciledAt?: Date | null;

  @Column({ name: 'reconciled_by', type: 'uuid', nullable: true })
  reconciledBy?: string | null;

  @Column({ name: 'payment_cheque_id', type: 'uuid', nullable: true })
  paymentChequeId?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
