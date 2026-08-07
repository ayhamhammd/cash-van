import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A customer document photo uploaded BEFORE the customer exists.
 *
 * A salesman photographs the shop's registration or the owner's ID while
 * standing in front of them, and only then fills the form. When the creation
 * needs admin approval the customer row may not exist for hours, so the bytes
 * have nowhere to hang — `customer_attachments.customer_id` is not nullable, and
 * making it nullable would let a real attachment drift orphaned forever.
 *
 * So the photo is staged here, referenced by id on the create request, and moved
 * to `customer_attachments` the moment the customer becomes real. `claimed_at`
 * marks the ones that made it, leaving the rest sweepable.
 */
@Entity({ name: 'pending_customer_photos' })
@Index('idx_pending_customer_photos_unclaimed', ['createdAt'])
export class PendingCustomerPhoto {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Object-store key the bytes were saved under (relative to the storage root). */
  @Column({ name: 'storage_key', type: 'text' })
  storageKey!: string;

  @Column({ type: 'text' })
  url!: string;

  @Column({ name: 'original_name', type: 'text' })
  originalName!: string;

  @Column({ name: 'mime_type', type: 'text' })
  mimeType!: string;

  @Column({ name: 'size_bytes', type: 'integer', default: 0 })
  sizeBytes!: number;

  @Column({ name: 'uploaded_by', type: 'uuid', nullable: true })
  uploadedBy?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** Set when the photo became a real customer attachment. Null = still staged. */
  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true })
  claimedAt?: Date | null;
}
