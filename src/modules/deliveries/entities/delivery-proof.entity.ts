import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type DeliveryProofKind = 'PHOTO' | 'SIGNATURE';

/**
 * A shipment photo or the customer's signature, uploaded by the phone before
 * its result (`POST sync/delivery-proofs`). The file lives in StorageService
 * under `storage_key`; `erp_attachment_id` is set once the outbox has copied it
 * to the ERP, and the result waits for that.
 */
@Entity({ name: 'delivery_proofs' })
@Index('uq_delivery_proofs_client_ref', ['clientRef'], { unique: true })
@Index('idx_delivery_proofs_stop', ['stopId', 'kind'])
export class DeliveryProof {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'client_ref', type: 'text' })
  clientRef!: string;

  @Column({ name: 'stop_id', type: 'uuid' })
  stopId!: string;

  @Column({ type: 'text' })
  kind!: DeliveryProofKind;

  @Column({ name: 'storage_key', type: 'text' })
  storageKey!: string;

  @Column({ type: 'text' })
  mime!: string;

  @Column({ name: 'size_bytes', type: 'integer' })
  sizeBytes!: number;

  @Column({ name: 'captured_at', type: 'timestamptz', nullable: true })
  capturedAt?: Date | null;

  @Column({ name: 'erp_attachment_id', type: 'text', nullable: true })
  erpAttachmentId?: string | null;

  @Column({ name: 'uploaded_by', type: 'uuid', nullable: true })
  uploadedBy?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
