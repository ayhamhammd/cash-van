import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type HubWebhookStatus = 'received' | 'processed' | 'ignored' | 'error';

/**
 * Inbound events delivered by the Integration Hub (Hub → Van). Doubles as the
 * idempotency guard (unique `dedupKey`) and an audit log. See
 * docs/SPEC-integration-hub.md §3.3.
 */
@Entity({ name: 'hub_webhook_events' })
export class HubWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Stable per-event key (payload id / externalId, else a body hash). Dedup guard. */
  @Index('uq_hub_webhook_dedup', { unique: true })
  @Column({ name: 'dedup_key', type: 'text' })
  dedupKey!: string;

  @Column({ name: 'event_type', type: 'text' })
  eventType!: string;

  @Column({ name: 'external_id', type: 'text', nullable: true })
  externalId?: string | null;

  @Column({ name: 'payload', type: 'jsonb', nullable: true })
  payload?: Record<string, unknown> | null;

  @Index('idx_hub_webhook_status')
  @Column({ type: 'text', default: 'received' })
  status!: HubWebhookStatus;

  @Column({ type: 'text', nullable: true })
  error?: string | null;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date | null;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;
}
