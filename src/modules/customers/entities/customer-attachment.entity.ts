import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A file (document or spreadsheet) attached to a customer — e.g. commercial
 * registration, ID, signed contract, or an imported data sheet. Bytes live in
 * the object store (StorageService); this row holds the metadata + storage key.
 */
@Entity({ name: 'customer_attachments' })
@Index('idx_customer_attachments_customer', ['customerId', 'createdAt'])
export class CustomerAttachment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  /** Object-store key the bytes were saved under (relative to the storage root). */
  @Column({ name: 'storage_key', type: 'text' })
  storageKey!: string;

  /** Public URL the file is served from. */
  @Column({ type: 'text' })
  url!: string;

  /** Original client filename (for display + download). */
  @Column({ name: 'original_name', type: 'text' })
  originalName!: string;

  @Column({ name: 'mime_type', type: 'text' })
  mimeType!: string;

  @Column({ name: 'size_bytes', type: 'integer', default: 0 })
  sizeBytes!: number;

  /** User id (sub) that uploaded the file, or null. */
  @Column({ name: 'uploaded_by', type: 'uuid', nullable: true })
  uploadedBy?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
