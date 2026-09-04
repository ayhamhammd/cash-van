import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/** How a customer entered the segment. RULE rows are (re)written by the engine. */
export type SegmentMemberSource = 'MANUAL' | 'RULE' | 'IMPORT';

/**
 * One customer's membership in one segment — the single read path every consumer
 * (offers, analytics, rep assignment) uses. Both hand-picked and rule-driven
 * members land here, so a reader never needs to know how a customer got in.
 */
@Entity({ name: 'segment_customers' })
@Unique('uq_segment_customers_pair', ['segmentId', 'customerId'])
export class SegmentCustomer extends BaseEntity {
  @Index('idx_segment_customers_segment')
  @Column({ name: 'segment_id', type: 'uuid' })
  segmentId!: string;

  @Index('idx_segment_customers_customer')
  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  @Column({ type: 'text', default: 'MANUAL' })
  source!: SegmentMemberSource;

  @Column({ name: 'added_by', type: 'uuid', nullable: true })
  addedBy?: string | null;

  @Column({ name: 'added_at', type: 'timestamptz', default: () => 'now()' })
  addedAt!: Date;
}
