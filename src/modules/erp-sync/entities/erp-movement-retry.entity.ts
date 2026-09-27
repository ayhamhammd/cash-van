import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * An ERP stock movement the hub could not mirror yet, kept until it can.
 *
 * Stepping over one used to lose it: the feed cursor moved past it and nothing
 * ever asked for it again, so the van's figure was short by that movement for
 * good. It is stored whole so a retry does not depend on the ERP still returning
 * it from the same place in the feed.
 */
@Entity({ name: 'erp_movement_retry' })
export class ErpMovementRetry {
  /** The ERP movement id — the same key the `movement` id-map dedups on. */
  @PrimaryColumn({ name: 'erp_id', type: 'text' })
  erpId!: string;

  @Index('idx_erp_movement_retry_store')
  @Column({ type: 'text' })
  store!: string;

  /** The movement exactly as the feed returned it. */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'integer', default: 1 })
  attempts!: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null;

  @Column({ name: 'first_failed_at', type: 'timestamptz', default: () => 'now()' })
  firstFailedAt!: Date;

  @Column({ name: 'last_tried_at', type: 'timestamptz', default: () => 'now()' })
  lastTriedAt!: Date;
}
